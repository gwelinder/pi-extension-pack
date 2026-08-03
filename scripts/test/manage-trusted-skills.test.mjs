import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  applyActivationPlan,
  buildActivationPlan,
  buildLockPlan,
  hashDirectory,
  pathExists,
  reconcileSkillLock,
  safeJoin,
  validateContainedSymlinks,
  validateManifest,
} from "../manage-trusted-skills.mjs";
import { validateWayfinderPreview } from "../validate-wayfinder-preview.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trusted-skills-test-"));
}

function writeSkill(root, name, body = "Instructions\n") {
  const directory = path.join(root, "skills", name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill for deterministic manager validation.\n---\n\n${body}`);
  return directory;
}

function localManifest(skillHash) {
  return {
    version: 1,
    canonicalRoot: "~/.agents/skills",
    vendorRoot: "~/.agents/vendor/trusted-skills",
    backupRoot: "~/.agents/skill-backups/trusted-skills",
    lockFile: "~/.agents/.skill-lock.json",
    shadowRoots: {
      pi: "~/.pi/agent/skills",
      openclaw: "~/.openclaw/skills",
    },
    sources: {
      fixture: {
        kind: "local",
        revision: "v1",
        skills: [
          {
            name: "example-skill",
            path: "skills/example-skill",
            sha256: skillHash,
            dependencies: [],
          },
        ],
      },
    },
  };
}

test("safeJoin rejects paths outside the pinned source", () => {
  assert.throws(() => safeJoin("/tmp/source", "../escape"), /escapes/);
  assert.equal(safeJoin("/tmp/source", "skills/example"), "/tmp/source/skills/example");
});

test("hashDirectory changes with content and ignores timestamps", () => {
  const root = temporaryDirectory();
  try {
    const skill = writeSkill(root, "example-skill");
    const first = hashDirectory(skill);
    const file = path.join(skill, "SKILL.md");
    const now = new Date();
    fs.utimesSync(file, now, now);
    assert.equal(hashDirectory(skill), first);
    fs.appendFileSync(file, "changed\n");
    assert.notEqual(hashDirectory(skill), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reviewed skill directories reject escaping symlinks", () => {
  const root = temporaryDirectory();
  try {
    const skill = writeSkill(root, "example-skill");
    fs.symlinkSync("/etc/passwd", path.join(skill, "outside"));
    assert.throws(() => validateContainedSymlinks(skill), /escapes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifest requires full pins, hashes, and closed dependencies", () => {
  const valid = localManifest("a".repeat(64));
  assert.deepEqual([...validateManifest(valid)], ["example-skill"]);
  valid.sources.fixture.skills[0].dependencies = ["missing-skill"];
  assert.throws(() => validateManifest(valid), /unmanaged skill/);
});

test("activation backs up copies, installs canonical links, and removes shadows", () => {
  const root = temporaryDirectory();
  const home = path.join(root, "home");
  const fixtureRepo = path.join(root, "repo");
  const vendorSkill = writeSkill(path.join(home, ".agents", "vendor", "trusted-skills", "fixture", "v1"), "example-skill");
  const manifest = localManifest(hashDirectory(vendorSkill));
  const context = { home, repoRoot: fixtureRepo };
  const canonical = writeSkill(path.join(home, ".agents"), "example-skill", "old canonical\n");
  const piShadow = writeSkill(path.join(home, ".pi", "agent"), "example-skill", "old Pi copy\n");
  const openClawShadow = writeSkill(path.join(home, ".openclaw"), "example-skill", "old OpenClaw copy\n");
  const lockPath = path.join(home, ".agents", ".skill-lock.json");
  fs.writeFileSync(lockPath, `${JSON.stringify({ version: 3, skills: { "example-skill": { source: "old" }, untouched: { source: "other" } } }, null, 2)}\n`);

  try {
    const plan = buildActivationPlan(manifest, context);
    assert.deepEqual(plan.map((action) => action.kind).sort(), ["remove-shadow", "remove-shadow", "replace-link"]);
    const result = applyActivationPlan(manifest, context, plan);
    const lockPlan = buildLockPlan(manifest, context);
    assert.deepEqual(lockPlan.map((action) => action.name), ["example-skill"]);
    reconcileSkillLock(manifest, context, lockPlan, result.backupRoot);
    assert.equal(fs.lstatSync(canonical).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(canonical), fs.realpathSync(vendorSkill));
    assert.equal(pathExists(piShadow), false);
    assert.equal(pathExists(openClawShadow), false);
    assert.ok(result.backupRoot);
    assert.equal(pathExists(path.join(result.backupRoot, "agents", "example-skill", "SKILL.md")), true);
    assert.equal(pathExists(path.join(result.backupRoot, "pi", "example-skill", "SKILL.md")), true);
    const updatedLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(updatedLock.skills["example-skill"], undefined);
    assert.deepEqual(updatedLock.skills.untouched, { source: "other" });
    assert.equal(pathExists(path.join(result.backupRoot, "locks", "skill-lock.json")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("distribution apply replaces a copied target with a backed-up symlink", () => {
  const root = temporaryDirectory();
  const home = path.join(root, "home");
  const canonical = writeSkill(path.join(home, ".agents"), "grilling");
  const claudeCopy = writeSkill(path.join(home, ".claude"), "grilling", "old copied version\n");
  try {
    execFileSync(process.execPath, [path.join(repoRoot, "scripts", "sync-agent-skills.mjs"), "--apply", "--only=grilling"], {
      env: { ...process.env, TRUSTED_SKILLS_HOME: home },
      stdio: "pipe",
    });
    assert.equal(fs.lstatSync(claudeCopy).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(claudeCopy), fs.realpathSync(canonical));
    const backupRoot = path.join(home, ".agents", "skill-backups", "distribution");
    assert.equal(pathExists(backupRoot), true);
    const run = fs.readdirSync(backupRoot)[0];
    assert.equal(pathExists(path.join(backupRoot, run, "claude", "grilling", "SKILL.md")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the textbook Wayfinder pilot is source-backed, acyclic, and read-only", () => {
  const textbookRoot = "/Users/gfw/code/living-book/ai-vascular-textbook";
  const fixture = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "extras", "trusted-engineering-skills", "skills", "beads-wayfinder", "evals", "fixtures", "ai-vascular-textbook-avt-zq62-preview.json"), "utf8"),
  );
  const result = validateWayfinderPreview(fixture, textbookRoot);
  assert.equal(result.evidenceCount, 6);
  assert.equal(result.frontierCount, 4);
});

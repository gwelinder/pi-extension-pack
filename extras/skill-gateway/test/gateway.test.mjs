import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fallbackCatalog, loadSkill, matchBundle, parseFrontmatter, searchCatalog, skillRootsForCwd, tokenize } from "../core.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-gateway-test-"));
const first = path.join(tmp, "first");
const second = path.join(tmp, "second");
fs.mkdirSync(path.join(first, "browser-automation"), { recursive: true });
fs.mkdirSync(path.join(second, "browser-automation"), { recursive: true });
fs.mkdirSync(path.join(second, "cloudflare-ops"), { recursive: true });
fs.writeFileSync(path.join(first, "browser-automation", "SKILL.md"), `---\nname: browser-automation\ndescription: Automate logged-in browser workflows and screenshots.\ntags: [browser, chrome]\n---\n\n# Browser\nUse the browser safely.\n`);
fs.writeFileSync(path.join(second, "browser-automation", "SKILL.md"), `---\nname: browser-automation\ndescription: This duplicate must lose precedence.\n---\n\n# Wrong duplicate\n`);
fs.writeFileSync(path.join(second, "cloudflare-ops", "SKILL.md"), `---\nname: cloudflare-ops\ndescription: Operate Cloudflare Workers, D1, KV, and R2.\ntags: [cloudflare, workers]\n---\n\n# Cloudflare\nUse plan mode first.\n`);
const project = path.join(tmp, "project");
fs.mkdirSync(path.join(project, ".git"), { recursive: true });
fs.mkdirSync(path.join(project, ".pi", "skills", "project-specialist"), { recursive: true });
fs.writeFileSync(path.join(project, ".pi", "skills", "project-specialist", "SKILL.md"), `---\nname: project-specialist\ndescription: Handle this project's special workflow.\n---\n\n# Project\n`);

try {
  assert.deepEqual(tokenize("Use the logged-in browser/chrome workflow"), ["logged-in", "logged", "browser", "chrome", "workflow"]);
  assert.equal(parseFrontmatter(fs.readFileSync(path.join(first, "browser-automation", "SKILL.md"), "utf8")).name, "browser-automation");

  const catalog = fallbackCatalog([first, second]);
  assert.equal(catalog.length, 2);
  const projectRoots = skillRootsForCwd(project);
  assert.equal(projectRoots[0], path.join(project, ".pi", "skills"));
  assert.equal(fallbackCatalog(projectRoots).some((entry) => entry.name === "project-specialist"), true);
  assert.match(catalog.find((entry) => entry.name === "browser-automation").description, /logged-in/);

  const policy = {
    bundles: [
      { name: "browser", triggers: ["browser", "login"], skills: ["browser-automation"] },
      { name: "cloudflare", triggers: ["cloudflare", "workers"], skills: ["cloudflare-ops"] },
    ],
  };
  assert.deepEqual(searchCatalog("", catalog, 2, policy), []);
  assert.equal(loadSkill("SKILL:browser-automation", catalog).name, "browser-automation");

  const browser = searchCatalog("take a screenshot in my logged-in browser", catalog, 2, policy);
  assert.equal(browser[0].name, "browser-automation");
  assert.equal(browser[0].bundle, "browser");

  const cloudflare = searchCatalog("deploy cloudflare workers", catalog, 2, policy);
  assert.equal(cloudflare[0].name, "cloudflare-ops");
  assert.equal(matchBundle("deploy cloudflare workers", policy.bundles).name, "cloudflare");

  const loaded = loadSkill("browser-automation", catalog);
  assert.match(loaded.text, /Use the browser safely/);
  assert.equal(loadSkill("missing", catalog), null);
  console.log("skill-gateway core tests: PASS");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

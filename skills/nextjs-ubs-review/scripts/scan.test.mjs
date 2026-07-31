import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "scan.mjs");

function write(root, path, body) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nextjs-ubs-review-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  write(root, "README.md", "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

test("lists only changed Next.js server boundaries", () => {
  const root = fixture();
  try {
    write(root, "app/api/users/route.ts", "export async function GET() { return Response.json({ ok: true }) }\n");
    write(root, "src/pages/api/health.ts", "export default function handler() {}\n");
    write(root, "app/actions/save.ts", "'use server';\nexport async function save() {}\n");
    write(root, "app/account/action.ts", "'use server';\nexport async function update() {}\n");
    write(root, "middleware.ts", "export function middleware() {}\n");
    write(root, "app/dashboard/page.tsx", "export default function Page() { return <main /> }\n");
    write(root, "components/marketing/hero.tsx", "export function Hero() { return <h1>Hello</h1> }\n");

    const output = execFileSync(process.execPath, [script, "--list"], { cwd: root, encoding: "utf8" });
    assert.deepEqual(output.trim().split("\n"), [
      "app/account/action.ts",
      "app/actions/save.ts",
      "app/api/users/route.ts",
      "middleware.ts",
      "src/pages/api/health.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staged mode excludes unstaged server files", () => {
  const root = fixture();
  try {
    write(root, "app/api/staged/route.ts", "export async function GET() {}\n");
    write(root, "app/api/unstaged/route.ts", "export async function GET() {}\n");
    execFileSync("git", ["add", "app/api/staged/route.ts"], { cwd: root });

    const output = execFileSync(process.execPath, [script, "--staged", "--list"], { cwd: root, encoding: "utf8" });
    assert.equal(output.trim(), "app/api/staged/route.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns a machine-readable no-op for client-only changes", () => {
  const root = fixture();
  try {
    write(root, "components/card.tsx", "export function Card() { return <div /> }\n");
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, "no_applicable_files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs UBS on a selected route and returns JSON", (t) => {
  if (spawnSync("which", ["ubs"], { stdio: "ignore" }).status !== 0) {
    t.skip("ubs is not installed");
    return;
  }

  const root = fixture();
  try {
    write(root, "app/api/health/route.ts", "export async function GET() { return Response.json({ ok: true }) }\n");
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.match(result.stderr, /scanning 1 changed server file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

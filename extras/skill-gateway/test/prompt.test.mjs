import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { ExtensionRunner, SessionManager, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

const piRoot = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { loadExtensions } = await import(pathToFileURL(path.join(piRoot, "core/extensions/loader.js")));
const { buildSystemPrompt } = await import(pathToFileURL(path.join(piRoot, "core/system-prompt.js")));
const extensionPath = path.resolve(import.meta.dirname, "../index.ts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-gateway-prompt-"));
const savedMode = process.env.PI_SKILL_GATEWAY_MODE;
const savedTelemetry = process.env.PI_SKILL_GATEWAY_TELEMETRY_DIR;
process.env.PI_SKILL_GATEWAY_TELEMETRY_DIR = tmp;

const skills = [
  { name: "fixture", description: "Fixture with XML escaping: <one> & two.", filePath: path.join(tmp, "fixture/SKILL.md"), baseDir: path.join(tmp, "fixture"), source: "user", disableModelInvocation: false },
  { name: "hidden", description: "Hidden skill.", filePath: path.join(tmp, "hidden/SKILL.md"), baseDir: path.join(tmp, "hidden"), source: "user", disableModelInvocation: true },
];
const options = {
  cwd: tmp, skills, selectedTools: ["read", "bash"],
  toolSnippets: { read: "Read files", bash: "Run commands" },
  promptGuidelines: ["Preserve the user's safety requirements."],
  appendSystemPrompt: "# Working style\nKeep behavioral instructions.",
  contextFiles: [{ path: path.join(tmp, "AGENTS.md"), content: "Retain project instructions." }],
  sections: { memory: "Retain memory instructions.", safety: "Retain tool permission restrictions." },
};
const formatted = formatSkillsForPrompt(skills);
const section = formatted.trim();
const wrapped = `<skills>\n${section}\n</skills>`;
const current = buildSystemPrompt(options);
assert.ok(formatted.startsWith("\n\n"));
assert.ok(current.includes(wrapped));
assert.ok(!current.includes(formatted));

async function route(mode, input, nativeSkills = skills) {
  process.env.PI_SKILL_GATEWAY_MODE = mode;
  const loaded = await loadExtensions([extensionPath], tmp);
  assert.deepEqual(loaded.errors, []);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, tmp, SessionManager.inMemory(tmp));
  const errors = [];
  runner.onError((error) => errors.push(error));
  // Empty user input suppresses recommendations through the production internal-prompt check.
  const result = await runner.emitBeforeAgentStart("", undefined, { ...options, skills: nativeSkills, ...(input === undefined ? {} : { forceSystemPrompt: input }) });
  assert.deepEqual(errors, []);
  assert.deepEqual(result.systemPromptOptions.skills, nativeSkills);
  assert.deepEqual(result.systemPromptOptions.selectedTools, options.selectedTools);
  const records = fs.readdirSync(tmp).filter((file) => file.endsWith(".jsonl"));
  const stats = records.flatMap((file) => fs.readFileSync(path.join(tmp, file), "utf8").trim().split("\n").map(JSON.parse)).at(-1);
  return { prompt: buildSystemPrompt(result.systemPromptOptions), stats };
}

try {
  const fixtures = [
    ["current structured trimmed prompt", undefined, current, current.replace(wrapped, "")],
    ["untrimmed formatter prompt", `Original instructions${formatted}\nMore instructions`, `Original instructions${formatted}\nMore instructions`, "Original instructions\nMore instructions"],
    ["missing catalog", "Original instructions", "Original instructions", "Original instructions"],
    ["changed catalog", current.replace("&lt;one&gt;", "different"), current.replace("&lt;one&gt;", "different"), current.replace("&lt;one&gt;", "different")],
    ["duplicate structured catalogs", `${current}\n${wrapped}`, `${current}\n${wrapped}`, `${current}\n${wrapped}`],
    ["mixed trimmed and untrimmed catalogs", `${current}${formatted}`, `${current}${formatted}`, `${current}${formatted}`],
    ["duplicate untrimmed catalogs", `Original${formatted}${formatted}`, `Original${formatted}${formatted}`, `Original${formatted}${formatted}`],
    ["distinct additional catalog", `${current}\n${wrapped.replace("fixture", "other")}`, `${current}\n${wrapped.replace("fixture", "other")}`, `${current}\n${wrapped.replace("fixture", "other")}`],
    ["modified wrapper", current.replace(`<skills>\n${section}`, `<skills>\nKeep this instruction.\n${section}`), current.replace(`<skills>\n${section}`, `<skills>\nKeep this instruction.\n${section}`), current.replace(`<skills>\n${section}`, `<skills>\nKeep this instruction.\n${section}`)],
    ["inline wrapped catalog", `Keep quote: ${wrapped}\nEnd quote.`, `Keep quote: ${wrapped}\nEnd quote.`, `Keep quote: ${wrapped}\nEnd quote.`],
  ];
  for (const mode of ["routed", "off", "observe"]) {
    for (const [name, input, original, stripped] of fixtures) {
      await test(`${mode}: ${name}`, async () => {
        const expected = mode === "routed" ? stripped : original;
        const result = await route(mode, input);
        assert.equal(result.prompt, expected);
        assert.equal(result.stats.strippedChars, original.length - expected.length);
        assert.equal(result.stats.recommendationChars, 0);
      });
    }
  }
  await test("routed: no visible skills preserves prompt", async () => {
    const result = await route("routed", "Original instructions", [skills[1]]);
    assert.equal(result.prompt, "Original instructions");
    assert.equal(result.stats.strippedChars, 0);
  });
} finally {
  if (savedMode === undefined) delete process.env.PI_SKILL_GATEWAY_MODE;
  else process.env.PI_SKILL_GATEWAY_MODE = savedMode;
  if (savedTelemetry === undefined) delete process.env.PI_SKILL_GATEWAY_TELEMETRY_DIR;
  else process.env.PI_SKILL_GATEWAY_TELEMETRY_DIR = savedTelemetry;
  fs.rmSync(tmp, { recursive: true, force: true });
}

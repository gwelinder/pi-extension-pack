#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { fallbackCatalog, searchCatalog } from "../core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, "skill-gateway-eval.json");
const policy = JSON.parse(fs.readFileSync(path.join(here, "..", "policy.json"), "utf8"));
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const catalog = fallbackCatalog([
  path.join(os.homedir(), ".pi", "agent", "skills"),
  path.join(os.homedir(), ".agents", "skills"),
]);

let top1 = 0;
let top3 = 0;
const misses = [];
for (const fixture of fixtures) {
  const results = searchCatalog(fixture.task, catalog, 3, policy);
  const expected = new Set(fixture.correctSkills || []);
  if (results[0] && expected.has(results[0].name)) top1 += 1;
  if (results.some((result) => expected.has(result.name))) top3 += 1;
  else misses.push({ id: fixture.id, task: fixture.task, expected: [...expected], actual: results.map((result) => result.name) });
}

const total = fixtures.length;
const report = {
  fixturePath,
  catalogSize: catalog.length,
  total,
  top1: { count: top1, rate: total ? top1 / total : 0 },
  top3: { count: top3, rate: total ? top3 / total : 0 },
  gate: { minimumTop3: 0.8, passed: total > 0 && top3 / total >= 0.8 },
  misses,
};
console.log(JSON.stringify(report, null, 2));
if (!report.gate.passed) process.exitCode = 1;

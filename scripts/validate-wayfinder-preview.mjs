#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = argument.match(/^--([^=]+)=(.+)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertStringArray(value, name) {
  assert(Array.isArray(value) && value.length > 0, `${name} must be a non-empty array`);
  for (const item of value) assert(typeof item === "string" && item.trim().length > 0, `${name} contains an empty value`);
}

function assertAcyclic(tickets) {
  const byTitle = new Map(tickets.map((ticket) => [ticket.title, ticket]));
  assert(byTitle.size === tickets.length, "Frontier ticket titles must be unique");
  const visiting = new Set();
  const visited = new Set();

  function visit(title) {
    if (visited.has(title)) return;
    assert(!visiting.has(title), `Dependency cycle includes: ${title}`);
    visiting.add(title);
    const ticket = byTitle.get(title);
    assert(ticket, `Unknown frontier ticket: ${title}`);
    for (const blocker of ticket.blocked_by || []) {
      assert(byTitle.has(blocker), `${title} references unknown blocker: ${blocker}`);
      visit(blocker);
    }
    visiting.delete(title);
    visited.add(title);
  }

  for (const title of byTitle.keys()) visit(title);
}

export function validateWayfinderPreview(preview, repoRoot) {
  assert(preview.mode === "read-only-preview", "Pilot fixture must use read-only-preview mode");
  assert(Array.isArray(preview.writes_performed) && preview.writes_performed.length === 0, "Read-only pilot recorded writes");
  assert(Array.isArray(preview.observed_evidence) && preview.observed_evidence.length > 0, "Pilot needs observed evidence");
  for (const evidence of preview.observed_evidence) {
    assert(typeof evidence.path === "string" && evidence.path.length > 0, "Evidence path is missing");
    assert(typeof evidence.observation === "string" && evidence.observation.length > 0, `Evidence observation is missing for ${evidence.path}`);
    const evidencePath = path.resolve(repoRoot, evidence.path);
    assert(fs.existsSync(evidencePath), `Evidence path does not exist: ${evidence.path}`);
    const content = fs.readFileSync(evidencePath, "utf8");
    const expectedFragments = Array.isArray(evidence.contains) ? evidence.contains : [evidence.contains];
    assert(expectedFragments.length > 0 && expectedFragments.every((fragment) => typeof fragment === "string" && fragment.length > 0), `Evidence fragments are missing for ${evidence.path}`);
    for (const fragment of expectedFragments) {
      assert(content.includes(fragment), `Evidence drift in ${evidence.path}; missing fragment: ${fragment}`);
    }
  }

  const map = preview.proposed_map;
  assert(map && typeof map === "object", "Pilot needs a proposed_map");
  assert(typeof map.destination === "string" && map.destination.length > 0, "Map destination is missing");
  assertStringArray(map.boundaries, "boundaries");
  assertStringArray(map.stopping_evidence, "stopping_evidence");
  assert(Array.isArray(map.first_frontier) && map.first_frontier.length > 0, "Map needs a visible frontier");
  for (const ticket of map.first_frontier) {
    assert(typeof ticket.title === "string" && ticket.title.length > 0, "Frontier ticket title is missing");
    assert(["decision", "task"].includes(ticket.type), `${ticket.title} has unsupported type ${ticket.type}`);
    assert(["wayfinder:grilling", "wayfinder:research", "wayfinder:prototype", "wayfinder:task"].includes(ticket.label), `${ticket.title} has unsupported label ${ticket.label}`);
    assert(Array.isArray(ticket.blocked_by), `${ticket.title} needs a blocked_by array`);
    assert(typeof ticket.resolution_evidence === "string" && ticket.resolution_evidence.length > 0, `${ticket.title} lacks resolution evidence`);
  }
  assertAcyclic(map.first_frontier);

  const safetyAssertions = [
    "asked_user_for_discoverable_facts",
    "created_beads",
    "created_planning_markdown",
    "mutated_textbook_or_product_data",
    "started_implementation",
  ];
  for (const name of safetyAssertions) assert(preview.assertions?.[name] === false, `Safety assertion failed: ${name}`);
  return { evidenceCount: preview.observed_evidence.length, frontierCount: map.first_frontier.length };
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args.fixture) throw new Error("Usage: validate-wayfinder-preview.mjs --fixture=<json> [--repo=<repository>]");
  const fixturePath = path.resolve(args.fixture);
  const preview = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const repository = args.repo || process.env.WAYFINDER_PILOT_REPO || preview.repository;
  if (!repository) throw new Error("Pilot repository is missing; pass --repo or set it in the fixture");
  const repoRoot = path.resolve(repository);
  const result = validateWayfinderPreview(preview, repoRoot);
  console.log(`pilot valid    ${result.evidenceCount} evidence paths, ${result.frontierCount} frontier tickets, zero writes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

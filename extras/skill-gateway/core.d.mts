import type { Skill } from "@earendil-works/pi-coding-agent";

export interface CatalogEntry {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  tags: string[];
  mtimeMs: number;
  sourceScope: string;
  sourceOrigin: string;
}

export interface Bundle {
  name: string;
  triggers: string[];
  skills: string[];
}

export interface BundleMatch extends Bundle {
  score: number;
  matchedTriggers: string[];
}

export interface SearchPolicy {
  skillAliases?: Record<string, string[]>;
  bundles?: Bundle[];
}

export interface SearchResult extends CatalogEntry {
  score: number;
  matchedTokens: string[];
  bundle?: string;
}

export function tokenize(input: unknown): string[];
export function parseFrontmatter(text: string): Record<string, string>;
export function parseTags(raw: unknown): string[];
export function entryFromSkill(skill: Skill): CatalogEntry;
export function skillRootsForCwd(cwd: string): string[];
export function fallbackCatalog(roots?: string[]): CatalogEntry[];
export function searchCatalog(query: string, entries: CatalogEntry[], limit?: number, policy?: SearchPolicy): SearchResult[];
export function matchBundle(prompt: string, bundles: Bundle[]): BundleMatch | null;
export function loadSkill(name: string, entries: CatalogEntry[]): (CatalogEntry & { text: string }) | null;
export function truncate(text: unknown, maxChars: number): string;

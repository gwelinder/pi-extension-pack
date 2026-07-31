import { spawnSync } from "node:child_process";

export type CommandCandidate = {
  toolName: "exec_command" | "process" | "bash";
  command?: string;
  dynamic: boolean;
  reason?: string;
};

export type GuardDecision = {
  allow: boolean;
  reason?: string;
  ruleId?: string;
};

type Token = {
  kind: "identifier" | "string" | "template" | "regex" | "punctuation" | "number";
  value: string;
  start: number;
  end: number;
};

const COMMAND_TOOLS = new Set(["exec_command", "process", "bash"]);
const REGEX_PREFIX_PUNCTUATION = new Set([
  "(", "[", "{", ",", ";", ":", "=", "!", "?", "+", "-", "*", "%", "&", "|", "^", "~", "<", ">",
]);
const REGEX_PREFIX_IDENTIFIERS = new Set([
  "return", "throw", "case", "delete", "void", "typeof", "instanceof", "in", "of", "yield", "await", "else", "do",
]);

function isIdentifierStart(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z_$]/.test(char));
}

function isIdentifierPart(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_$]/.test(char));
}

function decodeStringLiteral(source: string, start: number): { value: string; end: number } {
  const quote = source[start];
  let value = "";
  let index = start + 1;

  while (index < source.length) {
    const char = source[index];
    if (char === quote) return { value, end: index + 1 };
    if (char !== "\\") {
      value += char;
      index++;
      continue;
    }

    index++;
    if (index >= source.length) break;
    const escaped = source[index];
    const simpleEscapes: Record<string, string> = {
      n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0",
    };
    if (escaped in simpleEscapes) {
      value += simpleEscapes[escaped];
      index++;
      continue;
    }
    if (escaped === "\n") {
      index++;
      continue;
    }
    if (escaped === "\r") {
      index += source[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (escaped === "x" && /^[0-9A-Fa-f]{2}$/.test(source.slice(index + 1, index + 3))) {
      value += String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 3), 16));
      index += 3;
      continue;
    }
    if (escaped === "u") {
      const braced = source.slice(index + 1).match(/^\{([0-9A-Fa-f]+)\}/);
      if (braced) {
        value += String.fromCodePoint(Number.parseInt(braced[1], 16));
        index += braced[0].length + 1;
        continue;
      }
      const raw = source.slice(index + 1, index + 5);
      if (/^[0-9A-Fa-f]{4}$/.test(raw)) {
        value += String.fromCharCode(Number.parseInt(raw, 16));
        index += 5;
        continue;
      }
    }
    value += escaped;
    index++;
  }

  return { value, end: source.length };
}

function skipTemplate(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "`") return index + 1;
    index++;
  }
  return source.length;
}

function shouldStartRegex(previous: Token | undefined): boolean {
  if (!previous) return true;
  if (previous.kind === "punctuation") return REGEX_PREFIX_PUNCTUATION.has(previous.value);
  return previous.kind === "identifier" && REGEX_PREFIX_IDENTIFIERS.has(previous.value);
}

function skipRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") inClass = true;
    if (char === "]") inClass = false;
    if (char === "/" && !inClass) {
      index++;
      while (/[A-Za-z]/.test(source[index] || "")) index++;
      return index;
    }
    if (char === "\n" || char === "\r") return index;
    index++;
  }
  return source.length;
}

export function tokenizeJavaScript(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const decoded = decodeStringLiteral(source, index);
      tokens.push({ kind: "string", value: decoded.value, start: index, end: decoded.end });
      index = decoded.end;
      continue;
    }
    if (char === "`") {
      const end = skipTemplate(source, index);
      tokens.push({ kind: "template", value: source.slice(index, end), start: index, end });
      index = end;
      continue;
    }
    if (char === "/" && shouldStartRegex(tokens.at(-1))) {
      const end = skipRegex(source, index);
      tokens.push({ kind: "regex", value: source.slice(index, end), start: index, end });
      index = end;
      continue;
    }
    if (isIdentifierStart(char)) {
      const start = index++;
      while (isIdentifierPart(source[index])) index++;
      tokens.push({ kind: "identifier", value: source.slice(start, index), start, end: index });
      continue;
    }
    if (/[0-9]/.test(char)) {
      const start = index++;
      while (/[0-9A-Za-z_.]/.test(source[index] || "")) index++;
      tokens.push({ kind: "number", value: source.slice(start, index), start, end: index });
      continue;
    }
    tokens.push({ kind: "punctuation", value: char, start: index, end: index + 1 });
    index++;
  }

  return tokens;
}

type ObjectProperty = { present: boolean; literal?: string };

function readObjectProperties(tokens: Token[], openBraceIndex: number): Map<string, ObjectProperty> | null {
  const properties = new Map<string, ObjectProperty>();
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = openBraceIndex; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === "{") braceDepth++;
    else if (token.value === "}") {
      braceDepth--;
      if (braceDepth === 0) return properties;
    } else if (token.value === "[") bracketDepth++;
    else if (token.value === "]") bracketDepth--;
    else if (token.value === "(") parenDepth++;
    else if (token.value === ")") parenDepth--;

    if (braceDepth !== 1 || bracketDepth !== 0 || parenDepth !== 0) continue;
    if (token.kind !== "identifier" && token.kind !== "string") continue;
    if (tokens[index + 1]?.value !== ":") continue;

    const valueToken = tokens[index + 2];
    properties.set(token.value, {
      present: true,
      literal: valueToken?.kind === "string" ? valueToken.value : undefined,
    });
  }

  return null;
}

function toolNameAt(tokens: Token[], index: number): { name: string; next: number } | null {
  if (tokens[index]?.kind !== "identifier" || tokens[index].value !== "tools") return null;
  if (tokens[index + 1]?.value === "." && tokens[index + 2]?.kind === "identifier") {
    return { name: tokens[index + 2].value, next: index + 3 };
  }
  if (
    tokens[index + 1]?.value === "[" &&
    tokens[index + 2]?.kind === "string" &&
    tokens[index + 3]?.value === "]"
  ) {
    return { name: tokens[index + 2].value, next: index + 4 };
  }
  return null;
}

function dynamicCandidate(toolName: CommandCandidate["toolName"], reason: string): CommandCandidate {
  return { toolName, dynamic: true, reason };
}

export function extractCodeModeCommands(source: string): CommandCandidate[] {
  const tokens = tokenizeJavaScript(source);
  const candidates: CommandCandidate[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const match = toolNameAt(tokens, index);
    if (!match) {
      if (tokens[index]?.kind === "identifier" && tokens[index].value === "tools") {
        candidates.push(dynamicCandidate("exec_command", "the Code Mode tools object is used indirectly"));
      }
      continue;
    }
    if (!COMMAND_TOOLS.has(match.name)) continue;

    const toolName = match.name as CommandCandidate["toolName"];
    if (tokens[match.next]?.value !== "(") {
      candidates.push(dynamicCandidate(toolName, `${toolName} is referenced indirectly`));
      continue;
    }
    if (tokens[match.next + 1]?.value !== "{") {
      candidates.push(dynamicCandidate(toolName, "command tool arguments are not a literal object"));
      continue;
    }
    const properties = readObjectProperties(tokens, match.next + 1);
    if (!properties) {
      candidates.push(dynamicCandidate(toolName, "command tool arguments could not be parsed"));
      continue;
    }

    if (toolName === "process") {
      const action = properties.get("action");
      if (action?.literal && action.literal !== "start") continue;
      if (!action?.literal) {
        candidates.push(dynamicCandidate(toolName, "process action is not a static string"));
        continue;
      }
    }

    const key = toolName === "exec_command" ? "cmd" : "command";
    const command = properties.get(key);
    if (!command?.present || command.literal === undefined) {
      candidates.push(dynamicCandidate(toolName, `${key} is not a static string`));
      continue;
    }
    candidates.push({ toolName, command: command.literal, dynamic: false });
  }

  return candidates;
}

export function runDcg(command: string, timeoutMs = 1500): GuardDecision {
  const executable = process.env.DCG_BIN?.trim() || "dcg";
  const result = spawnSync(executable, ["--robot", "test", "--stdin"], {
    input: command,
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      ...process.env,
      DCG_ROBOT: "1",
      DCG_FAIL_CLOSED: "1",
      DCG_HOOK_TIMEOUT_MS: String(Math.max(10, timeoutMs - 250)),
    },
  });

  if (result.error) {
    return { allow: false, reason: `DCG could not evaluate the command (${result.error.message})` };
  }

  let payload: Record<string, unknown> | undefined;
  try {
    payload = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
  } catch {
    return { allow: false, reason: "DCG returned an unreadable decision" };
  }

  if (result.status === 0 && payload.decision === "allow") return { allow: true };
  const reason = typeof payload.reason === "string" ? payload.reason : `DCG returned ${String(payload.decision || "an indeterminate decision")}`;
  const ruleId = typeof payload.rule_id === "string" ? payload.rule_id : undefined;
  return { allow: false, reason, ruleId };
}

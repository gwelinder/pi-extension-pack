import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));

export type CodeGraphExecutableSource =
  | 'PI_CODEGRAPH_BIN'
  | 'package dependency'
  | 'ancestor node_modules/.bin'
  | 'PATH';

export type CodeGraphExecutable = {
  path: string;
  source: CodeGraphExecutableSource;
};

export function packageCodeGraphBin(fromUrl = import.meta.url): string | undefined {
  try {
    const requireFromExtension = createRequire(fromUrl);
    const packageJsonPath = requireFromExtension.resolve(
      '@colbymchenry/codegraph/package.json'
    );
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf8')
    ) as { bin?: string | Record<string, string> };
    const bin =
      typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin?.codegraph;
    if (!bin) return;
    const candidate = path.join(path.dirname(packageJsonPath), bin);
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return;
  }
}

export function ancestorBin(
  name: string,
  startDir = extensionDir
): string | undefined {
  let current = startDir;
  for (;;) {
    const candidate = path.join(current, 'node_modules', '.bin', name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function resolveCodeGraphExecutable(
  configuredBin = process.env.PI_CODEGRAPH_BIN
): CodeGraphExecutable {
  if (configuredBin?.trim()) {
    return { path: configuredBin.trim(), source: 'PI_CODEGRAPH_BIN' };
  }
  const packageBin = packageCodeGraphBin();
  if (packageBin) return { path: packageBin, source: 'package dependency' };
  const ancestor = ancestorBin('codegraph');
  if (ancestor) return { path: ancestor, source: 'ancestor node_modules/.bin' };
  return { path: 'codegraph', source: 'PATH' };
}

export function resolveCodeGraphBin(
  configuredBin = process.env.PI_CODEGRAPH_BIN
): string {
  return resolveCodeGraphExecutable(configuredBin).path;
}

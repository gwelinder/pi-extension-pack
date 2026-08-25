import { describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DefaultResourceLoader,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import codegraphExtension from './index';

const packageRoot = path.resolve(import.meta.dir, '../..');
const codeGraphPackage = {
  source: packageRoot,
  extensions: ['extensions/codegraph/**'],
  skills: [],
  prompts: [],
  themes: [],
};

function captureCodeGraphTool(): { execute: Function } {
  let tool: { execute: Function } | undefined;
  codegraphExtension({
    registerTool(value: { execute: Function }) {
      tool = value;
    },
    on() {},
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
  } as never);
  return tool!;
}

describe('CodeGraph canonical package startup', () => {
  test('keeps the project package filter and its project source metadata', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pi-codegraph-startup-'));
    const agentDir = path.join(root, 'agent');
    const projectDir = path.join(root, 'project');
    try {
      mkdirSync(path.join(projectDir, '.pi'), { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        path.join(agentDir, 'settings.json'),
        JSON.stringify({
          packages: [{ ...codeGraphPackage, extensions: [] }],
        })
      );
      writeFileSync(
        path.join(projectDir, '.pi', 'settings.json'),
        JSON.stringify({ packages: [codeGraphPackage] })
      );

      const settings = SettingsManager.create(projectDir, agentDir, {
        projectTrusted: true,
      });
      const loader = new DefaultResourceLoader({
        cwd: projectDir,
        agentDir,
        settingsManager: settings,
      });
      await loader.reload();
      const extensions = loader.getExtensions();

      expect(extensions.errors).toEqual([]);
      expect(extensions.extensions).toHaveLength(1);
      expect(extensions.extensions[0]?.resolvedPath).toBe(
        path.join(packageRoot, 'extensions/codegraph/index.ts')
      );
      expect(extensions.extensions[0]?.sourceInfo.scope).toBe('project');
      expect(extensions.extensions[0]?.tools.has('codegraph')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps copied CodeGraph paths, reports their conflict, and preserves unrelated tools', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pi-codegraph-collision-'));
    const agentDir = path.join(root, 'agent');
    const projectDir = path.join(root, 'project');
    const copiedCodeGraph = path.join(agentDir, 'extensions', 'codegraph');
    try {
      mkdirSync(path.join(projectDir, '.pi'), { recursive: true });
      mkdirSync(copiedCodeGraph, { recursive: true });
      symlinkSync(path.join(packageRoot, 'node_modules'), path.join(root, 'node_modules'));
      copyFileSync(
        path.join(packageRoot, 'extensions/codegraph/index.ts'),
        path.join(copiedCodeGraph, 'index.ts')
      );
      copyFileSync(
        path.join(packageRoot, 'extensions/codegraph/executable.ts'),
        path.join(copiedCodeGraph, 'executable.ts')
      );
      writeFileSync(
        path.join(agentDir, 'extensions', 'unrelated.ts'),
        `export default (pi) => pi.registerTool({ name: 'unrelated', label: 'Unrelated', description: 'Unrelated startup proof', parameters: { type: 'object', properties: {} }, async execute() { return { content: [{ type: 'text', text: 'ok' }], details: {} }; } });\n`
      );
      writeFileSync(
        path.join(agentDir, 'settings.json'),
        JSON.stringify({ packages: [] })
      );
      writeFileSync(
        path.join(projectDir, '.pi', 'settings.json'),
        JSON.stringify({ packages: [codeGraphPackage] })
      );

      const settings = SettingsManager.create(projectDir, agentDir, {
        projectTrusted: true,
      });
      const loader = new DefaultResourceLoader({
        cwd: projectDir,
        agentDir,
        settingsManager: settings,
      });
      await loader.reload();
      const extensions = loader.getExtensions();
      const paths = extensions.extensions.map((extension) => extension.resolvedPath);
      const packageCodeGraph = path.join(
        packageRoot,
        'extensions/codegraph/index.ts'
      );
      const copiedCodeGraphPath = path.join(copiedCodeGraph, 'index.ts');

      expect(paths).toContain(packageCodeGraph);
      expect(paths).toContain(copiedCodeGraphPath);
      expect(paths.indexOf(copiedCodeGraphPath)).toBeLessThan(
        paths.indexOf(packageCodeGraph)
      );
      expect(extensions.errors).toContainEqual({
        path: packageCodeGraph,
        error: `Tool "codegraph" conflicts with ${copiedCodeGraphPath}`,
      });
      expect(
        extensions.extensions.some((extension) =>
          extension.tools.has('unrelated')
        )
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports the package-owned executable in tool diagnostics', async () => {
    const result = await captureCodeGraphTool().execute(
      'tool-call',
      { action: 'status' },
      undefined,
      () => {},
      { cwd: packageRoot }
    );
    const details = result.details as {
      executablePath: string;
      executableSource: string;
    };

    expect(details.executableSource).toBe('package dependency');
    expect(details.executablePath).toMatch(/codegraph\/npm-shim\.js$/);
    expect(result.content[0]?.text).toContain(
      `Executable: ${details.executablePath} (package dependency)`
    );
  });

  test('reports executable diagnostics for nonexistent projects and missing indexes', async () => {
    const tool = captureCodeGraphTool();
    const nonexistent = path.join(os.tmpdir(), 'pi-codegraph-does-not-exist');
    const missingProject = await tool.execute(
      'tool-call',
      { action: 'status', projectPath: nonexistent },
      undefined,
      () => {},
      { cwd: packageRoot }
    );
    const missingIndex = await tool.execute(
      'tool-call',
      { action: 'search', query: 'resolver', projectPath: packageRoot },
      undefined,
      () => {},
      { cwd: packageRoot }
    );

    for (const result of [missingProject, missingIndex]) {
      const details = result.details as {
        executablePath: string;
        executableSource: string;
      };
      expect(result.isError).toBe(true);
      expect(details.executableSource).toBe('package dependency');
      expect(details.executablePath).toMatch(/codegraph\/npm-shim\.js$/);
      expect(result.content[0]?.text).toContain(
        `Executable: ${details.executablePath} (package dependency)`
      );
    }
  });
});

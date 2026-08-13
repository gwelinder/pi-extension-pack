import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  ancestorBin,
  packageCodeGraphBin,
  resolveCodeGraphExecutable,
} from './executable';

describe('CodeGraph executable resolution', () => {
  test('prefers an explicit configured executable and identifies its source', () => {
    expect(resolveCodeGraphExecutable('  /tmp/custom-codegraph  ')).toEqual({
      path: '/tmp/custom-codegraph',
      source: 'PI_CODEGRAPH_BIN',
    });
  });

  test('resolves the dependency owned by pi-extension-pack', () => {
    const resolved = packageCodeGraphBin();
    expect(resolved).toBeDefined();
    expect(path.basename(resolved!)).toBe('npm-shim.js');
    expect(resolveCodeGraphExecutable()).toEqual({
      path: resolved,
      source: 'package dependency',
    });
  });

  test('finds the package-local executable shim from a descendant', () => {
    expect(ancestorBin('codegraph', import.meta.dir)).toBe(
      path.resolve(import.meta.dir, '../../node_modules/.bin/codegraph')
    );
  });
});

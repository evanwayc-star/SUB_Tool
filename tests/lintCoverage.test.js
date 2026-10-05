import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

describe('CI launcher 的靜態安全網', () => {
  it('Node ESM 允許 runtime globals，並阻擋未宣告名稱', async () => {
    const eslint = new ESLint();
    const [valid] = await eslint.lintText('import path from "node:path"; process.exitCode = path ? 0 : 1;', {
      filePath: 'scripts/ci/coverage-probe.mjs',
    });
    expect(valid.errorCount).toBe(0);
    const [invalid] = await eslint.lintText('process.exitCode = subtoolMissingBinding;', {
      filePath: 'scripts/ci/coverage-probe.mjs',
    });
    expect(invalid.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'no-undef', severity: 2 }),
    ]));
  });
});

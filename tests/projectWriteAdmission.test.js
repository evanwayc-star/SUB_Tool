import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { commitAdmittedProjectWrite, inspectProjectWrite, createTrustedProjectIntake } = require('../electron/project-file-authority-engine.js');

function projectBytes(project, encoding = 'utf8') {
  if (encoding === 'utf16le') {
    return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(JSON.stringify(project), 'utf16le')]);
  }
  return Buffer.from(JSON.stringify(project), 'utf8');
}

describe('renderer project write admission', () => {
  it('admits valid project bytes only when every declared media path already has read capability', () => {
    const allowed = new Set(['D:\\Media\\master.mxf', 'E:\\Audio\\mix.wav']);
    const result = inspectProjectWrite(projectBytes({
      media: { path: 'D:\\Media\\master.mxf' },
      clips: [{ path: 'D:\\Media\\master.mxf' }],
      externalAudioSources: [{ path: 'E:\\Audio\\mix.wav' }],
    }, 'utf16le'), { canRead: mediaPath => allowed.has(mediaPath) });

    expect(result).toEqual({
      allowed: true,
      reason: null,
      mediaPaths: ['D:\\Media\\master.mxf', 'E:\\Audio\\mix.wav'],
      unauthorizedPaths: [],
    });
  });

  it('blocks save-to-recent capability laundering through an undeclared renderer-owned path', () => {
    const result = inspectProjectWrite(projectBytes({
      media: { path: 'C:\\Users\\Evan\\secret.json' },
    }), { canRead: () => false });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unauthorized-media');
    expect(result.unauthorizedPaths).toEqual(['C:\\Users\\Evan\\secret.json']);
  });

  it('blocks malformed and non-project JSON before either save boundary can persist it', () => {
    expect(inspectProjectWrite(Buffer.from('{broken'), { canRead: () => true }).reason).toBe('invalid-project');
    expect(inspectProjectWrite(Buffer.from('[]'), { canRead: () => true }).reason).toBe('invalid-project');
  });

  it('does not require a read capability when a valid project declares no local media', () => {
    const result = inspectProjectWrite(projectBytes({ clips: [], externalAudioSources: [] }));
    expect(result.allowed).toBe(true);
    expect(result.mediaPaths).toEqual([]);
  });

  it('the production write transaction clears old relink declarations only after the write succeeds', async () => {
    const intake = createTrustedProjectIntake({
      grantProjectFile: () => {}, grantMediaFile: () => {},
    });
    const projectPath = 'C:\\Projects\\edit.subtool';
    intake.grant(projectPath, projectBytes({ media: { path: 'D:\\Media\\old.mxf' } }));
    expect(intake.canRelink(projectPath, 'D:\\Media\\old.mxf')).toBe(true);

    const writes = [];
    await expect(commitAdmittedProjectWrite(projectPath, projectBytes({ cues: [] }), {
      ensureDirectory: file => { writes.push(['mkdir', file]); },
      writeFile: (file, contents) => { writes.push(['write', file, contents]); },
      clearTrustedDeclarations: file => intake.grantProjectOnly(file),
    })).resolves.toBe(projectPath);
    expect(writes.map(call => call.slice(0, 2))).toEqual([
      ['mkdir', projectPath],
      ['write', projectPath],
    ]);
    expect(intake.canRelink(projectPath, 'D:\\Media\\old.mxf')).toBe(false);

    intake.grant(projectPath, projectBytes({ media: { path: 'D:\\Media\\old.mxf' } }));
    await expect(commitAdmittedProjectWrite(projectPath, projectBytes({ cues: [] }), {
      writeFile: () => { throw new Error('disk full'); },
      clearTrustedDeclarations: file => intake.grantProjectOnly(file),
    })).rejects.toThrow('disk full');
    expect(intake.canRelink(projectPath, 'D:\\Media\\old.mxf')).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProjectFileGateway } = require('../electron/project-file-gateway.js');
const { createTrustedProjectIntake } = require('../electron/trusted-project-intake.js');

const bytes = project => Buffer.from(JSON.stringify(project));

function fixture(initialProject = { media: { path: 'D:\\Media\\old.mxf' } }) {
  const grants = [];
  const recent = [];
  const writes = [];
  const intake = createTrustedProjectIntake({
    grantProjectFile: file => grants.push(['project', file]),
    grantMediaFile: file => grants.push(['media', file]),
  });
  const gateway = createProjectFileGateway({
    readFile: vi.fn(async () => bytes(initialProject)),
    writeFile: vi.fn(async (file, contents) => { writes.push(['write', file, contents]); }),
    ensureDirectory: vi.fn(async file => { writes.push(['mkdir', file]); }),
    grantTrustedProject: (file, contents) => intake.grant(file, contents),
    clearTrustedDeclarations: file => intake.grantProjectOnly(file),
    rememberRecent: file => recent.push(file),
  });
  return { gateway, grants, intake, recent, writes };
}

describe('project file gateway', () => {
  it('reads and parses a dropped project before granting or remembering anything', async () => {
    const valid = fixture();
    await expect(valid.gateway.openTrusted('C:\\Projects\\edit.subtool')).resolves.toEqual({
      path: 'C:\\Projects\\edit.subtool',
      b64: bytes({ media: { path: 'D:\\Media\\old.mxf' } }).toString('base64'),
    });
    expect(valid.grants).toEqual([
      ['project', 'C:\\Projects\\edit.subtool'],
      ['media', 'D:\\Media\\old.mxf'],
    ]);
    expect(valid.recent).toEqual(['C:\\Projects\\edit.subtool']);

    const invalid = fixture();
    invalid.gateway = createProjectFileGateway({
      readFile: async () => Buffer.from('{broken'),
      grantTrustedProject: (file, contents) => invalid.intake.grant(file, contents),
      rememberRecent: file => invalid.recent.push(file),
    });
    await expect(invalid.gateway.openTrusted('C:\\Projects\\broken.subtool')).resolves.toBeNull();
    expect(invalid.grants).toEqual([]);
    expect(invalid.recent).toEqual([]);
  });

  it('both save and exact-write modes clear old relink declarations after a successful write', async () => {
    const projectPath = 'C:\\Projects\\edit.subtool';
    const fx = fixture();
    fx.intake.grant(projectPath, bytes({ media: { path: 'D:\\Media\\old.mxf' } }));
    expect(fx.intake.canRelink(projectPath, 'D:\\Media\\old.mxf')).toBe(true);

    await expect(fx.gateway.writeRendererProject(projectPath, bytes({ cues: [] }), {
      ensureParent: true,
    })).resolves.toBe(projectPath);
    expect(fx.writes.map(call => call.slice(0, 2))).toEqual([
      ['mkdir', projectPath],
      ['write', projectPath],
    ]);
    expect(fx.intake.canRelink(projectPath, 'D:\\Media\\old.mxf')).toBe(false);
    expect(fx.recent).toEqual([]);

    fx.intake.grant(projectPath, bytes({ media: { path: 'D:\\Media\\old.mxf' } }));
    await expect(fx.gateway.writeRendererProject(projectPath, bytes({ cues: [] }), {
      remember: true,
    })).resolves.toBe(projectPath);
    expect(fx.intake.canRelink(projectPath, 'D:\\Media\\old.mxf')).toBe(false);
    expect(fx.recent).toEqual([projectPath]);
  });

  it('does not clear declarations or remember a project when the write fails', async () => {
    const projectPath = 'C:\\Projects\\edit.subtool';
    const intake = createTrustedProjectIntake({ grantProjectFile: () => {}, grantMediaFile: () => {} });
    intake.grant(projectPath, bytes({ media: { path: 'D:\\Media\\old.mxf' } }));
    const rememberRecent = vi.fn();
    const gateway = createProjectFileGateway({
      writeFile: async () => { throw new Error('disk full'); },
      clearTrustedDeclarations: file => intake.grantProjectOnly(file),
      rememberRecent,
    });

    await expect(gateway.writeRendererProject(projectPath, bytes({ cues: [] }), { remember: true }))
      .rejects.toThrow('disk full');
    expect(intake.canRelink(projectPath, 'D:\\Media\\old.mxf')).toBe(true);
    expect(rememberRecent).not.toHaveBeenCalled();
  });
});

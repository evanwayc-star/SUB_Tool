import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { createTrustedProjectIntake } = require('../electron/project-file-authority-engine.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('trusted project intake', () => {
  it('uses the main-process bytes to grant exactly the project and its declared media', () => {
    const grants = [];
    const bytes = Buffer.from(JSON.stringify({
      media: { path: 'D:\\Media\\master.mxf' },
      clips: [{ path: 'D:\\Media\\insert.mov' }],
    }));
    const intake = createTrustedProjectIntake({
      readFile: () => { throw new Error('the supplied bytes should be reused'); },
      grantProjectFile: file => grants.push(['project', file]),
      grantMediaFile: file => grants.push(['media', file]),
    });

    expect(intake.grant('D:\\Projects\\edit.subtool', bytes)).toBe(bytes);
    expect(grants).toEqual([
      ['project', 'D:\\Projects\\edit.subtool'],
      ['media', 'D:\\Media\\master.mxf'],
      ['media', 'D:\\Media\\insert.mov'],
    ]);
  });

  it('reads the selected file itself when no trusted bytes were already obtained', () => {
    const grants = [];
    const bytes = Buffer.from(JSON.stringify({ media: { path: 'E:\\Media\\program.mov' } }));
    const intake = createTrustedProjectIntake({
      readFile: file => {
        expect(file).toBe('E:\\Projects\\program.subtool');
        return bytes;
      },
      grantProjectFile: file => grants.push(['project', file]),
      grantMediaFile: file => grants.push(['media', file]),
    });

    expect(intake.grant('E:\\Projects\\program.subtool')).toBe(bytes);
    expect(grants).toEqual([
      ['project', 'E:\\Projects\\program.subtool'],
      ['media', 'E:\\Media\\program.mov'],
    ]);
  });

  it('can authorize an admitted native save destination without interpreting renderer-provided media paths', () => {
    const grants = [];
    const intake = createTrustedProjectIntake({
      grantProjectFile: file => grants.push(['project', file]),
      grantMediaFile: file => grants.push(['media', file]),
    });

    expect(intake.grantProjectOnly('F:\\Projects\\new.subtool')).toBe('F:\\Projects\\new.subtool');
    expect(grants).toEqual([['project', 'F:\\Projects\\new.subtool']]);
  });

  it('does not grant a project capability when trusted bytes could not be obtained', () => {
    const grants = [];
    const intake = createTrustedProjectIntake({
      readFile: () => { throw new Error('unreadable'); },
      grantProjectFile: file => grants.push(['project', file]),
      grantMediaFile: file => grants.push(['media', file]),
    });

    expect(intake.grant('F:\\Projects\\missing.subtool')).toBeNull();
    expect(grants).toEqual([]);
  });

  it('does not grant capabilities for readable bytes that are not a valid project object', () => {
    const grants = [];
    const intake = createTrustedProjectIntake({
      grantProjectFile: file => grants.push(['project', file]),
      grantMediaFile: file => grants.push(['media', file]),
    });

    expect(intake.grant('F:\\Projects\\broken.subtool', Buffer.from('{broken'))).toBeNull();
    expect(intake.grant('F:\\Projects\\array.json', Buffer.from('[]'))).toBeNull();
    expect(grants).toEqual([]);
  });

  it('allows relink only for a media path declared by that exact trusted project', () => {
    const intake = createTrustedProjectIntake({
      pathModule: path.win32,
      caseInsensitive: true,
      grantProjectFile: () => {},
      grantMediaFile: () => {},
    });
    intake.grant('C:\\Projects\\edit.subtool', Buffer.from(JSON.stringify({
      media: { path: 'D:\\Media\\master.mxf' },
    })));

    expect(intake.canRelink('c:\\projects\\EDIT.subtool', 'd:\\media\\MASTER.mxf')).toBe(true);
    expect(intake.canRelink('C:\\Projects\\edit.subtool', 'D:\\Media\\secret.txt')).toBe(false);
    expect(intake.canRelink('C:\\Projects\\other.subtool', 'D:\\Media\\master.mxf')).toBe(false);
  });

  it('clears trusted relink declarations when renderer bytes overwrite a saved project path', () => {
    const intake = createTrustedProjectIntake({
      pathModule: path.win32,
      grantProjectFile: () => {},
      grantMediaFile: () => {},
    });
    intake.grant('C:\\Projects\\edit.subtool', Buffer.from(JSON.stringify({
      media: { path: 'D:\\Media\\master.mxf' },
    })));
    expect(intake.canRelink('C:\\Projects\\edit.subtool', 'D:\\Media\\master.mxf')).toBe(true);

    intake.grantProjectOnly('C:\\Projects\\edit.subtool');
    expect(intake.canRelink('C:\\Projects\\edit.subtool', 'D:\\Media\\master.mxf')).toBe(false);
  });

  it('does not expose a renderer-controlled project authorization channel', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
    const project = fs.readFileSync(path.join(ROOT, 'src', 'project.js'), 'utf8');

    expect(main).not.toContain("'fs:authorizeProject'");
    expect(preload).not.toMatch(/authorizeProject\s*:/);
    expect(project).not.toMatch(/DESK\.authorizeProject/);
    // Executable read/write ordering is covered by projectWorkspace.test;
    // these remain supplemental checks that both IPC edges actually delegate.
    expect(main).toMatch(/dialog:saveProject[\s\S]*?projectWorkspace\.acceptsRendererProject\(b64\)[\s\S]*?projectWorkspace\.writeRendererProject\(r\.filePath/);
    expect(main).toMatch(/fs:writeProject[\s\S]*?projectWorkspace\.writeRendererProject\(p/);
    expect(main).toMatch(/fs:findRelinkTarget[\s\S]*?projectWorkspace\.canRelink\(projectPath, oldMediaPath\)/);
    expect(main).toMatch(/app\.on\('open-file'[\s\S]{0,300}deliverExternalProjectOpen\(projectPath\)/);
    expect(main).toMatch(/app:getStartupFile[\s\S]{0,400}projectWorkspace\.openStartup\(args\)/);
    expect(main).not.toMatch(/app\.on\('open-file'[\s\S]{0,500}grantTrustedProjectFile\(/);
    expect(preload).toMatch(/openDroppedProject[\s\S]*?project:openDroppedFile/);
    expect(preload).not.toMatch(/openDroppedProject[\s\S]{0,260}fs:authorizeDroppedFile/);
  });
});

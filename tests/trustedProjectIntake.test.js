import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const require = createRequire(import.meta.url);
const { createTrustedProjectIntake } = require('../electron/project-file-authority-engine.js');
const { FileAuthority } = require('../electron/file-authority.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directories = [];

function relinkFixture() {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-relink-test-'));
  directories.push(directory);
  const projectPath = path.join(directory, 'edit.subtool');
  const oldMediaPath = path.join(directory, 'missing', 'master.mxf');
  const fileAuthority = new FileAuthority();
  const projectWorkspace = createTrustedProjectIntake({
    grantProjectFile: file => fileAuthority.grantProjectFile(file),
    grantMediaFile: file => fileAuthority.grantTrustedFile(file, { read: true, write: false }),
  });
  const bytes = Buffer.from(JSON.stringify({ media: { path: oldMediaPath } }));
  fs.writeFileSync(projectPath, bytes);
  projectWorkspace.grant(projectPath, bytes);
  const source = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const search = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'findFileRecursively');
  const registration = ast.body.find(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'CallExpression'
    && node.expression.callee.object?.name === 'ipcMain'
    && node.expression.callee.property?.name === 'handle'
    && node.expression.arguments[0]?.value === 'fs:findRelinkTarget');
  expect(search).toBeDefined();
  expect(registration).toBeDefined();
  let handler;
  const context = { fs, path, fileAuthority, projectWorkspace, ipcMain: { handle: (_, fn) => { handler = fn; } } };
  vm.runInNewContext(`${source.slice(search.start, search.end)}\n${source.slice(registration.start, registration.end)}`, context);
  return { directory, projectPath, oldMediaPath, fileAuthority, handler };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('subtool-relink-test-')) {
      throw new Error('拒絕清除未驗證的重連測試路徑');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

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

  it.each([false, true])('實際 main 重連略過同名目錄，只授權找到的媒體檔案（有巢狀檔案=%s）', async hasFile => {
    const { directory, projectPath, oldMediaPath, fileAuthority, handler } = relinkFixture();
    const collision = path.join(directory, 'master.mxf');
    fs.mkdirSync(collision);
    const media = path.join(collision, 'master.mxf');
    if (hasFile) fs.writeFileSync(media, 'relocated media content');
    expect(fileAuthority.canRead(collision)).toBe(false);
    expect(fileAuthority.canRead(media)).toBe(false);

    await expect(handler({}, { projectPath, oldMediaPath })).resolves.toBe(hasFile ? media : null);

    expect(fileAuthority.canRead(collision)).toBe(false);
    expect(fileAuthority.canRead(media)).toBe(hasFile);
    expect(fileAuthority.canWrite(media)).toBe(false);
    expect(fs.readdirSync(collision)).toEqual(hasFile ? ['master.mxf'] : []);
  });

  it('實際 main 不以未宣告的 renderer 檔名搜尋並授權專案旁的檔案', async () => {
    const { directory, projectPath, fileAuthority, handler } = relinkFixture();
    const sibling = path.join(directory, 'private.wav');
    fs.writeFileSync(sibling, 'private sibling');
    await expect(handler({}, { projectPath, oldMediaPath: path.join(directory, 'missing', 'private.wav') })).resolves.toBeNull();
    expect(fileAuthority.canRead(sibling)).toBe(false);
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

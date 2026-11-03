import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';

const require = createRequire(import.meta.url);
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const real = fs.realpathSync(root);
    if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith('subtool-shared-root-')) throw new Error('拒絕刪除測試目錄以外資料');
    fs.rmSync(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

it.each(['prepareSharedLeaseRoot', 'prepareAcceptanceSharedLeaseRoot'])
('%s 保留已准入根目錄的原請求別名，仍核對實體目錄及別名替換', prepare => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-shared-root-')); roots.push(root);
  const physical = path.join(root, 'physical'), alias = path.join(root, 'requested-alias');
  const replacement = path.join(root, 'replacement');
  fs.mkdirSync(physical); fs.mkdirSync(replacement);
  fs.symlinkSync(physical, alias, 'junction');
  const lease = require('../electron/export-lease');
  const admitted = lease.captureOutputDirectory(alias);
  expect(admitted.requestedPath).toBe(alias);
  expect(admitted.path).toBe(fs.realpathSync.native(physical));
  expect(admitted.requestedPath).not.toBe(admitted.path);

  const shared = lease[prepare](alias);
  lease.assertOutputAuthority(shared.sharedAuthority, shared.sharedAuthority.requestedPath);
  const prefix = prepare === 'prepareAcceptanceSharedLeaseRoot' ? ['.subtool-acceptance-shared'] : [];
  expect(fs.realpathSync.native(shared.sharedQueueDir))
    .toBe(path.join(fs.realpathSync.native(physical), ...prefix, 'SUB_Tool', 'shared-output-leases'));
  expect(shared.sharedAuthority.rootPath).toBe(path.join(alias, ...prefix, 'SUB_Tool'));
  const parent = shared.sharedAuthority.parents[0], stat = fs.lstatSync(parent.path, { bigint: true });
  expect(parent).toMatchObject({ dev: String(stat.dev), ino: String(stat.ino) });

  fs.unlinkSync(alias);
  fs.symlinkSync(replacement, alias, 'junction');
  expect(() => lease.assertOutputAuthority(shared.sharedAuthority, shared.sharedAuthority.requestedPath)).toThrow();
  expect(fs.readdirSync(replacement)).toEqual([]);
});

it('Windows 資料夾虛擬化使非連結的 appData 子目錄 realpath 不同時，仍綁定原請求與實體目錄', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-shared-root-')); roots.push(root);
  const appData = path.join(root, 'appdata'), physical = path.join(root, 'redirected');
  fs.mkdirSync(appData); fs.mkdirSync(physical);
  const virtual = path.join(appData, 'SUB_Tool');
  const map = file => {
    if (typeof file !== 'string') return file;
    const relative = path.relative(virtual, file);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
      ? path.join(physical, relative) : file;
  };
  const realpath = Object.assign((file, ...args) => fs.realpathSync(map(file), ...args),
    { native: (file, ...args) => fs.realpathSync.native(map(file), ...args) });
  const io = new Proxy(fs, { get(target, key) {
    if (key === 'realpathSync') return realpath;
    if (key === 'lstatSync' || key === 'mkdirSync') return (file, ...args) => target[key](map(file), ...args);
    return target[key];
  } });
  const filename = path.resolve('electron/export-lease.js'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: name => name === 'node:fs' ? io : require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name),
    process, Buffer, __dirname: path.dirname(filename) }, { filename });
  const shared = module.exports.prepareSharedLeaseRoot(appData);
  module.exports.assertOutputAuthority(shared.sharedAuthority, shared.sharedAuthority.requestedPath);
  expect(fs.statSync(path.join(physical, 'shared-output-leases', 'output-leases')).isDirectory()).toBe(true);
  expect(shared.sharedAuthority.rootPath.toLowerCase()).toBe(virtual.toLowerCase());
});

it('appData 第一層 junction 仍拒絕且不在外部位置建立鎖目錄', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-shared-root-')); roots.push(root);
  const appData = path.join(root, 'appdata'), outside = path.join(root, 'outside');
  fs.mkdirSync(appData); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(appData, 'SUB_Tool'), 'junction');
  expect(() => require('../electron/export-lease').prepareSharedLeaseRoot(appData)).toThrow();
  expect(fs.readdirSync(outside)).toEqual([]);
});

it('驗收旗標與明確隔離 profile 同時存在時才用 profile 鎖根，重啟相同 profile 可復原', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-shared-root-')); roots.push(root);
  const appData = path.join(root, 'real-appdata'), a = path.join(root, 'profile-a'), b = path.join(root, 'profile-b');
  for (const dir of [appData, a, b]) fs.mkdirSync(dir);
  const source = fs.readFileSync('electron/main.js', 'utf8');
  const definition = parse(source, { ecmaVersion: 'latest' }).body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'prepareApplicationSharedLeaseRoot');
  const invoke = (acceptance, profile, explicitProfile) => vm.runInNewContext(`${source.slice(definition.start, definition.end)}; prepareApplicationSharedLeaseRoot()`, {
    IS_TRANSPORT_ACCEPTANCE: acceptance, ExportLease: require('../electron/export-lease'), path, process,
    app: { getPath: name => name === 'appData' ? appData : profile, commandLine: { getSwitchValue: () => explicitProfile } },
  });
  const first = invoke(true, a, a), restarted = invoke(true, a, a), second = invoke(true, b, b);
  expect(first.sharedQueueDir).toBe(restarted.sharedQueueDir);
  expect(first.sharedQueueDir).not.toBe(second.sharedQueueDir);
  expect(fs.readdirSync(appData)).toEqual([]);
  expect(() => invoke(true, a, '')).toThrow(/隔離/);
  expect(() => invoke(true, a, b)).toThrow(/隔離/);
  const production = invoke(false, a, '');
  expect(production.sharedQueueDir).toBe(path.join(appData, 'SUB_Tool', 'shared-output-leases'));
  expect(invoke(false, b, '').sharedQueueDir).toBe(production.sharedQueueDir);
});

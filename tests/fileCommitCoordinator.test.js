import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createFileCommitCoordinator, fileCommitCoordinator } = require('../electron/file-commit-coordinator');
const { createAtomicProjectWriter } = require('../electron/project-file-authority-engine');
const roots = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
function root() {
  const result = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-commit-coordinator-'));
  roots.push(result); return result;
}
afterEach(() => {
  for (const directory of roots.splice(0)) {
    const actual = fs.realpathSync(directory);
    if (path.dirname(actual) !== fs.realpathSync(os.tmpdir()) || !path.basename(actual).startsWith('subtool-commit-coordinator-')) throw new Error('拒絕刪除測試目錄外路徑');
    fs.rmSync(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});

it('父目錄別名指向同一目的檔時，第二個工作等第一個實際結束', async () => {
  const base = root(), real = path.join(base, 'real'), alias = path.join(base, 'alias');
  fs.mkdirSync(real); fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const coordinator = createFileCommitCoordinator(), release = deferred(), started = deferred(), second = vi.fn();
  const a = coordinator.withCommitTargets([path.join(real, 'x.subtool')], async () => { started.resolve(); await release.promise; });
  await started.promise;
  const b = coordinator.withCommitTargets([path.join(alias, 'x.subtool')], second);
  await tick(); expect(second).not.toHaveBeenCalled();
  release.resolve(); await Promise.all([a, b]); expect(second).toHaveBeenCalledOnce();
});

it('尚未建立的巢狀輸出資料夾也能預留，建立後同一目標仍互斥', async () => {
  const base = root(), file = path.join(base, 'new', 'nested', 'style.json');
  const coordinator = createFileCommitCoordinator(), release = deferred(), started = deferred(), second = vi.fn();
  const a = coordinator.withCommitTargets([file], async () => {
    fs.mkdirSync(path.dirname(file), {recursive:true}); started.resolve(); await release.promise;
  });
  await started.promise;
  const b = coordinator.withCommitTargets([file], second);
  try { await tick(); expect(second).not.toHaveBeenCalled(); }
  finally { release.resolve(); }
  await Promise.all([a,b]); expect(second).toHaveBeenCalledOnce();
});

it('部分模式標示無法解析的項目，仍保護其餘合法目標', async () => {
  const base = root(), good = path.join(base, 'good.json'), bad = path.join(base, 'folder'), nested = path.join(base, 'new', 'b.json');
  fs.mkdirSync(bad);
  const coordinator = createFileCommitCoordinator(), release = deferred(), started = deferred(), second = vi.fn();
  const batch = coordinator.withCommitTargets([good,bad,nested], async ({rejectedIndices}) => {
    expect(rejectedIndices).toEqual([1]); started.resolve(); await release.promise;
  }, {allowPartial:true});
  await started.promise;
  const later = coordinator.withCommitTargets([good], second);
  try { await tick(); expect(second).not.toHaveBeenCalled(); }
  finally { release.resolve(); }
  await Promise.all([batch,later]); expect(second).toHaveBeenCalledOnce();
  await expect(coordinator.withCommitTargets([bad], () => {})).rejects.toThrow('目的檔不是一般檔案');
});

it('部分模式處理全部拒絕與空清單，但 I/O 錯誤仍向 caller 拋出', async () => {
  const base = root(), bad = path.join(base, 'directory'), denied = path.join(base, 'denied'); fs.mkdirSync(bad);
  const io = { ...fs.promises, lstat(file,...args) {
    if (file === denied) return Promise.reject(Object.assign(new Error('拒絕讀取'), {code:'EACCES'}));
    return fs.promises.lstat(file,...args);
  } };
  const coordinator = createFileCommitCoordinator({io}), work = vi.fn();
  await coordinator.withCommitTargets([bad,bad], work, {allowPartial:true});
  expect(work).toHaveBeenLastCalledWith({rejectedIndices:[0,1]});
  await coordinator.withCommitTargets([], work, {allowPartial:true});
  expect(work).toHaveBeenLastCalledWith({rejectedIndices:[]});
  const before = work.mock.calls.length;
  await expect(coordinator.withCommitTargets([path.join(base,'good'),denied],work,{allowPartial:true}))
    .rejects.toMatchObject({code:'EACCES'});
  expect(work).toHaveBeenCalledTimes(before);
});

it('較早呼叫的路徑解析較慢時，較新提交不得先取得同一目標', async () => {
  const base = root(), file = path.join(base, 'x.subtool');
  const resolveGate = deferred(), resolving = deferred(), workGate = deferred(), firstStarted = deferred();
  let delayed = false;
  const io = { ...fs.promises, async realpath(value, ...args) {
    if (value === base && !delayed) { delayed = true; resolving.resolve(); await resolveGate.promise; }
    return fs.promises.realpath(value, ...args);
  } };
  const coordinator = createFileCommitCoordinator({io}), second = vi.fn();
  const a = coordinator.withCommitTargets([file], async () => { firstStarted.resolve(); await workGate.promise; });
  await resolving.promise;
  const b = coordinator.withCommitTargets([file], second);
  try {
    await tick(); expect(second).not.toHaveBeenCalled();
    resolveGate.resolve(); await firstStarted.promise;
    await tick(); expect(second).not.toHaveBeenCalled();
  } finally { resolveGate.resolve(); workGate.resolve(); }
  await Promise.all([a,b]); expect(second).toHaveBeenCalledOnce();
});

it('同 inode 的不同 hardlink 目錄項保持獨立，不把兩個檔名合併', async () => {
  const base = root(), left = path.join(base, 'a.subtool'), right = path.join(base, 'b.subtool');
  fs.writeFileSync(left, 'same'); fs.linkSync(left, right);
  const coordinator = createFileCommitCoordinator(), release = deferred(), started = deferred(), second = vi.fn();
  const a = coordinator.withCommitTargets([left], async () => { started.resolve(); await release.promise; });
  await started.promise;
  try { await coordinator.withCommitTargets([right], second); expect(second).toHaveBeenCalledOnce(); }
  finally { release.resolve(); await a; }
});

it('8.3 短檔名展開為同一目錄項後與長名稱互斥', async () => {
  const base = root(), full = path.join(base, 'long-project-document.subtool'), short = path.join(base, 'LONGPR~1.SUB');
  fs.writeFileSync(full, 'project');
  const io = { ...fs.promises,
    lstat: (file, ...args) => fs.promises.lstat(file === short ? full : file, ...args),
    realpath: (file, ...args) => fs.promises.realpath(file === short ? full : file, ...args),
  };
  const coordinator = createFileCommitCoordinator({ io, caseInsensitive:true }), release = deferred(), started = deferred(), second = vi.fn();
  const a = coordinator.withCommitTargets([full], async () => { started.resolve(); await release.promise; });
  await started.promise;
  const b = coordinator.withCommitTargets([short], second);
  try { await tick(); expect(second).not.toHaveBeenCalled(); }
  finally { release.resolve(); }
  await Promise.all([a, b]); expect(second).toHaveBeenCalledOnce();
});

it('等待的工作取消後，後續工作仍須等目前 owner 收尾', async () => {
  const file = path.join(root(), 'x.subtool'), coordinator = createFileCommitCoordinator();
  const release = deferred(), started = deferred(), cancelled = new AbortController(), third = vi.fn();
  const a = coordinator.withCommitTargets([file], async () => { started.resolve(); await release.promise; });
  await started.promise;
  const b = coordinator.withCommitTargets([file], vi.fn(), { signal: cancelled.signal });
  const c = coordinator.withCommitTargets([file], third);
  await tick(); cancelled.abort(); await expect(b).rejects.toMatchObject({ name:'AbortError' });
  await tick(); expect(third).not.toHaveBeenCalled();
  release.resolve(); await Promise.all([a, c]); expect(third).toHaveBeenCalledOnce();
});

it('多目標以穩定順序取得；失敗釋放全部資格且 drain 等真正結束', async () => {
  const base = root(), a = path.join(base, 'a'), b = path.join(base, 'b');
  const coordinator = createFileCommitCoordinator(), release = deferred(), started = deferred(), second = vi.fn();
  const first = coordinator.withCommitTargets([b, a], async () => { started.resolve(); await release.promise; throw new Error('失敗'); });
  const outcome = first.catch(error => error);
  await started.promise;
  const other = coordinator.withCommitTargets([a, b], second);
  let drained = false; const draining = coordinator.drain().then(() => { drained = true; });
  await tick(); expect(drained).toBe(false); expect(second).not.toHaveBeenCalled();
  release.resolve(); expect((await outcome).message).toBe('失敗');
  await other; await draining; expect(second).toHaveBeenCalledOnce(); expect(drained).toBe(true);
});

it('關閉時拒絕新工作並等待已受理工作；舊的恢復不能撤銷新的關閉', async () => {
  const file = path.join(root(), 'x.subtool'), coordinator = createFileCommitCoordinator();
  const release = deferred(), started = deferred();
  const active = coordinator.withCommitTargets([file], async () => { started.resolve(); await release.promise; });
  await started.promise;
  let finished = false;
  const closing = coordinator.close().then(() => { finished = true; });
  await expect(coordinator.withCommitTargets([file], vi.fn())).rejects.toMatchObject({ code:'FILE_COMMIT_CLOSED' });
  const staleResume = coordinator.resume();
  const newerClose = coordinator.close();
  await tick(); expect(finished).toBe(false);
  release.resolve(); await active; await closing; await newerClose;
  expect(await staleResume).toBe(false);
  await expect(coordinator.withCommitTargets([file], vi.fn())).rejects.toMatchObject({ code:'FILE_COMMIT_CLOSED' });
  expect(await coordinator.resume()).toBe(true);
  await expect(coordinator.withCommitTargets([file], () => 'ok')).resolves.toBe('ok');
});

it('路徑解析期間取消，drain 等待底層 I/O 真正收尾且不啟動提交', async () => {
  const base = root(), file = path.join(base, 'x.subtool'), release = deferred(), started = deferred();
  let held = false;
  const io = { ...fs.promises, async realpath(input, ...args) {
    if (!held && input === base) { held = true; started.resolve(); await release.promise; }
    return fs.promises.realpath(input, ...args);
  } };
  const coordinator = createFileCommitCoordinator({ io }), controller = new AbortController(), work = vi.fn();
  const pending = coordinator.withCommitTargets([file], work, { signal:controller.signal });
  const outcome = pending.catch(error => error);
  await started.promise; controller.abort();
  let drained = false; const draining = coordinator.drain().then(() => { drained = true; });
  await tick(); expect(drained).toBe(false); expect(work).not.toHaveBeenCalled();
  release.resolve(); expect((await outcome).name).toBe('AbortError');
  await draining; expect(drained).toBe(true); expect(work).not.toHaveBeenCalled();
});

it('目錄輸出持有目的檔期間，真實專案儲存不得提前發布', async () => {
  const base = root(), file = path.join(base, 'project.subtool'); fs.writeFileSync(file, '原專案');
  const release = deferred(), started = deferred();
  const other = fileCommitCoordinator.withCommitTargets([file], async () => { started.resolve(); await release.promise; });
  await started.promise;
  const writer = createAtomicProjectWriter(), write = writer(file, Buffer.from('新專案'));
  let finished = false; write.finally(() => { finished = true; }).catch(() => {});
  try { await tick(); expect(finished).toBe(false); expect(fs.readFileSync(file, 'utf8')).toBe('原專案'); }
  finally { release.resolve(); }
  await Promise.all([other, write]); expect(fs.readFileSync(file, 'utf8')).toBe('新專案');
});

it('較早專案儲存仍在解析路徑時，較新的目錄輸出不能搶先並被舊檔覆蓋', async () => {
  const base = root(), file = path.join(base, 'project.subtool'); fs.writeFileSync(file, '原專案');
  const release = deferred(), started = deferred(); let delayed = false;
  const writer = createAtomicProjectWriter({ fsModule:{...fs,...fs.promises,async realpath(input,...args){
    if (!delayed && input === base) { delayed = true; started.resolve(); await release.promise; }
    return fs.promises.realpath(input,...args);
  }} });
  const older = writer(file, Buffer.from('較舊專案'));
  await started.promise;
  const newerWork = vi.fn(() => {
    const stage=path.join(base,'newer.tmp');fs.writeFileSync(stage,'較新匯出');fs.renameSync(stage,file);
  });
  const newer = fileCommitCoordinator.withCommitTargets([file], newerWork);
  try { await tick(); expect(newerWork).not.toHaveBeenCalled(); }
  finally { release.resolve(); await Promise.allSettled([older,newer]); }
  await Promise.all([older,newer]);
  expect(fs.readFileSync(file,'utf8')).toBe('較新匯出');
});

it('同一 project writer 的並行儲存不因兩層准入互相等待，後一筆最後發布', async () => {
  const base = root(), file = path.join(base, 'project.subtool'); fs.writeFileSync(file, '原專案');
  const release = deferred(), started = deferred(); let first = true;
  const writer = createAtomicProjectWriter({fsModule:{...fs,...fs.promises,async open(input,flags,...args){
    if (flags === 'wx' && first) { first = false; started.resolve(); await release.promise; }
    return fs.promises.open(input,flags,...args);
  }}});
  const older = writer(file, Buffer.from('較舊專案'));
  await started.promise;
  const newer = writer(file, Buffer.from('較新專案'));
  try { await tick(); expect(fs.readFileSync(file,'utf8')).toBe('原專案'); }
  finally { release.resolve(); }
  await Promise.all([older,newer]);
  expect(fs.readFileSync(file,'utf8')).toBe('較新專案');
});

it('專案備份在尚未建立的巢狀資料夾儲存，不與自己的目的地解析競爭', async () => {
  const base=root(), first=path.join(base,'.subtool_AutoSave'), file=path.join(first,'nested','backup.subtool');
  const created=deferred(), originalLstat=fs.promises.lstat.bind(fs.promises);
  const io={...fs,...fs.promises,async mkdir(directory,...args){
    const result=await fs.promises.mkdir(directory,...args);
    if(directory===first)created.resolve();
    return result;
  }};
  let held=false;
  const spy=vi.spyOn(fs.promises,'lstat').mockImplementation(async (target,...args)=>{
    if(target===first&&!held){
      held=true;
      let timer;
      try { await Promise.race([created.promise,new Promise(resolve=>{timer=setTimeout(resolve,150);})]); }
      finally { clearTimeout(timer); }
    }
    return originalLstat(target,...args);
  });
  const writer=createAtomicProjectWriter({fsModule:io});
  try {
    await expect(writer(file,Buffer.from('備份內容'),{ensureParent:true})).resolves.toBeUndefined();
    expect(fs.readFileSync(file,'utf8')).toBe('備份內容');
  } finally {spy.mockRestore();}
});

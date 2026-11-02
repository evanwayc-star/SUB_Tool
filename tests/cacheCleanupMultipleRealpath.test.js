import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { FileAuthority } = require('../electron/file-authority');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime');
let root;
afterEach(() => {
  vi.restoreAllMocks();
  if (root && path.dirname(root) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith('subtool-cache-multi-realpath-')) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  root = null;
});

it.each(['cleanOrphans', 'clearAll'].flatMap(cleanup => ['cancel', 'error'].map(firstOutcome => ({ cleanup, firstOutcome }))))
('$cleanup 的同源雙工作，一份 $firstOutcome 後 realpath 失敗仍不可刪活躍母素材', async ({ cleanup, firstOutcome }) => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-cache-multi-realpath-'));
  const cacheRoot = path.join(root, 'cache'), tempRoot = path.join(root, 'temp');
  const source = path.join(cacheRoot, 'source-folder', 'source.mov');
  const other = path.join(cacheRoot, 'other-folder', 'other.bin');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(other)); fs.mkdirSync(tempRoot);
  fs.writeFileSync(source, 'active mother source'); fs.writeFileSync(other, 'other pending cache');
  const authority = new FileAuthority({ internalDirectories: [cacheRoot, tempRoot] });
  authority.grantTrustedFile(source);
  const runtime = createMediaIntakeRuntime({ cacheRoot, tempRoot, allowSidecarCache: false,
    fileAuthority: authority, delay: async () => {}, ffmpegExecution: { async execute() { throw new Error('first writer failure'); } } });
  const gates = [], entered = [];
  for (let index = 0; index < 2; index++) {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    gates.push({ gate, release, started }); entered.push(ready);
  }
  let firstCancelled = false, secondCancelled = false, count = 0;
  const realRead = fs.promises.readdir.bind(fs.promises);
  const reader = vi.spyOn(fs.promises, 'readdir').mockImplementation(async (directory, ...args) => {
    if (path.resolve(String(directory)) === cacheRoot && count < gates.length) {
      const slot = gates[count++]; slot.started(); await slot.gate;
    }
    return realRead(directory, ...args);
  });
  const request = { src: source, duration: 1, needsProxy: false, audio: [{ channels: 1 }] };
  const first = runtime.ingest(request, { isCancelled: () => firstCancelled }); first.catch(() => {});
  const second = runtime.stream(request, { isCancelled: () => secondCancelled }); second.catch(() => {});
  let nativeSpy;
  try {
    await Promise.all(entered);
    firstCancelled = firstOutcome === 'cancel'; gates[0].release();
    const firstError = await first.catch(error => error);
    if (firstOutcome === 'error') expect(firstError.message).toContain('first writer failure');
    const native = fs.realpathSync.native;
    nativeSpy = vi.spyOn(fs.realpathSync, 'native').mockImplementation((file, ...args) => {
      if (path.resolve(String(file)) === source) throw Object.assign(new Error('source identity unavailable'), { code: 'EACCES' });
      return native(file, ...args);
    });
    const uncertain = cleanup === 'clearAll' ? await runtime.clearAll(null) : await runtime.cleanOrphans();
    expect(uncertain.incomplete).toBe(true);
    expect(fs.readFileSync(source, 'utf8')).toBe('active mother source');
    expect(fs.readFileSync(other, 'utf8')).toBe('other pending cache');
    nativeSpy.mockRestore(); nativeSpy = null;
    const stillActive = cleanup === 'clearAll' ? await runtime.clearAll(null) : await runtime.cleanOrphans();
    expect(stillActive.incomplete).toBe(true);
    expect(fs.readFileSync(source, 'utf8')).toBe('active mother source');
    secondCancelled = true; gates[1].release(); await second.catch(() => {});
    const completed = cleanup === 'clearAll' ? await runtime.clearAll(null) : await runtime.cleanOrphans();
    expect(completed.incomplete).toBe(false);
    expect(fs.existsSync(source)).toBe(false);
  } finally {
    nativeSpy?.mockRestore(); reader.mockRestore();
    firstCancelled = true; secondCancelled = true; gates.forEach(slot => slot.release());
    await Promise.allSettled([first, second]); await runtime.close();
  }
}, 10000);

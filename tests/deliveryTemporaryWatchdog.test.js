import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { spawnExportWatchdog, recoverExportLeases } = require('../electron/export-watchdog');
const { captureOutputDirectory, captureOutputAuthority, captureDestinationEvidenceAsync, listLeases, prepareSharedLeaseRoot } = require('../electron/export-lease');
const { createDeliveryTemporaryInputs } = require('../electron/delivery-temporary-input');
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const real = fs.realpathSync(root);
    if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith('subtool-delivery-input-')) throw new Error('拒絕刪除測試目錄以外資料');
    fs.rmSync(real, { recursive: true, force: true });
  }
});

it.each(['ass', 'ttf'])('編碼期間 %s 暫存輸入換檔，真 watchdog 保留成品及輸出鎖', async extension => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-delivery-input-'));
  roots.push(root);
  const target = path.join(root, 'delivery.mp4'), queueDir = path.join(root, 'queue');
  const script = path.join(root, 'writer.cjs'), marker = path.join(root, 'started.txt'), gate = path.join(root, 'finish');
  fs.writeFileSync(target, 'original delivery');
  fs.writeFileSync(script, "const fs=require('node:fs');const [marker,gate,out]=process.argv.slice(2);fs.writeFileSync(out,'completed output');fs.writeFileSync(marker,'started');const timer=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(timer);process.exit(0)}},20);");
  const inputs = createDeliveryTemporaryInputs({ tempDir: root });
  const name = inputs.create(extension, Buffer.from('original temporary input'));
  const input = path.join(root, name), previous = `${input}.previous`;
  const evidence = inputs.evidence();
  const messages = [];
  const controller = spawnExportWatchdog({ ffmpegPath: process.execPath, args: [script, marker, gate, target],
    cwd: root, outPath: target, jobId: `input-${extension}`, queueDir, inputEvidence: evidence, ...prepareSharedLeaseRoot(root),
    outputAuthority: await captureDestinationEvidenceAsync(captureOutputAuthority(target, captureOutputDirectory(root))) }, { onMessage: message => messages.push(message) });
  controller.ready.catch(() => {}); controller.completion.catch(() => {});
  const exited = new Promise(resolve => controller.child.once('exit', resolve));
  try {
    await controller.ready;
    await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true));
    fs.renameSync(input, previous); fs.writeFileSync(input, 'foreign input');
    fs.writeFileSync(gate, 'finish');
    expect(await controller.completion).toMatchObject({ ok: false, cleanup: { retainedLease: true } });
    await exited;
    expect(messages).toContainEqual(expect.objectContaining({ type: 'error', code: 'DELIVERY_TEMP_INPUT_CHANGED' }));
    const entry = listLeases(queueDir)[0];
    expect(entry.owner.retainedResult.code).toBe('DELIVERY_TEMP_INPUT_CHANGED');
    expect(fs.readFileSync(entry.owner.stagePath, 'utf8')).toBe('completed output');
    expect(fs.readFileSync(target, 'utf8')).toBe('original delivery');
    expect(fs.readFileSync(input, 'utf8')).toBe('foreign input');
    inputs.cleanup();
    expect(fs.readFileSync(input, 'utf8')).toBe('foreign input');
    const recovery = await recoverExportLeases(queueDir);
    expect(recovery.warnings).toContainEqual(expect.objectContaining({ code: 'DELIVERY_TEMP_INPUT_CHANGED' }));
    expect(fs.readFileSync(entry.owner.stagePath, 'utf8')).toBe('completed output');
  } finally {
    controller.stop('test-cleanup');
    await controller.completion.catch(() => null);
  }
}, 30000);

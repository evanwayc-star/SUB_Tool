'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { estimateDeliveryBytes } = require('../shared/delivery-formats.cjs');

// Existing destinations already occupy space reported by statfs. Do not assume
// any of it can be reclaimed before the same-directory atomic commit.
async function inspectDeliverySpace(spec, queueDir, { stat = fs.stat, statfs = fs.statfs, pending = [] } = {}) {
  const output = estimateDeliveryBytes(spec);
  if (!output) return '無法估算此次交付所需空間';
  const allocations = [{ directory: path.dirname(spec.outPath), bytes: output }];
  if (spec.format === 'dvd-iso' || spec.format === 'bd-iso') {
    // DVD authoring keeps the encoded MPG and VIDEO_TS tree until ISO validation.
    allocations.push({ directory: queueDir, bytes: output * (spec.format === 'dvd-iso' ? 2 : 1) });
  }
  const disks = new Map(), unknown = [], volumes = new Map();
  const volumeAt = async directory => {
    if (!volumes.has(directory)) volumes.set(directory, Promise.all([stat(directory, { bigint: true }), statfs(directory, { bigint: true })])
      .then(([entry, volume]) => {
        if (volume.bsize <= 0n || volume.bavail < 0n) throw new Error('volume information unavailable');
        return { id: entry.dev === 0n ? path.parse(directory).root : String(entry.dev),
          available: Number(volume.bavail * volume.bsize) };
      }));
    return volumes.get(directory);
  };
  for (const { directory, bytes } of allocations) {
    try {
      const { id, available } = await volumeAt(directory);
      const disk = disks.get(id) || { directory, available, bytes: 0, pending: 0 };
      disk.bytes += bytes;
      disks.set(id, disk);
    } catch { unknown.push(directory); }
  }
  const gb = bytes => (bytes / 1e9).toFixed(2) + ' GB';
  for (const disk of disks.values()) {
    if (disk.bytes > disk.available && spec.format === 'wav') throw Object.assign(new Error(
      `交付空間不足：${disk.directory} 預估需要 ${gb(disk.bytes)}，目前可用 ${gb(disk.available)}。`),
    { code: 'DELIVERY_DISK_SPACE' });
  }
  // Other queued/running files may finish after this check. Present this as a
  // planning estimate; the running job may already have written part of its stage.
  for (const item of pending) {
    if (!item.outPath || item.outPath === spec.outPath) continue;
    const estimate = estimateDeliveryBytes(item);
    if (!estimate) continue;
    try {
      const disk = disks.get((await volumeAt(path.dirname(item.outPath))).id);
      if (disk) disk.pending += estimate;
    } catch { /* Other destinations cannot invalidate this job's measurement. */ }
  }
  return [...disks.values()].map(disk => `${disk.bytes > disk.available ? '空間可能不足：' : ''}${disk.directory} 預估需 ${gb(disk.bytes)}，可用 ${gb(disk.available)}`
    + (disk.pending ? `，同磁碟其他交付預估 ${gb(disk.pending)}` : '')).concat(
    unknown.length ? [`無法查詢剩餘空間：${unknown.join('、')}`] : []).join('；');
}

module.exports = { inspectDeliverySpace };

import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { inspectDeliverySpace } = require('../electron/delivery-space');
const { estimateDeliveryBytes } = require('../shared/delivery-formats.cjs');

describe('交付所需磁碟空間', () => {
  const queue = path.resolve('queue'), output = path.resolve('export','disc.iso');
  const spec = {format:'dvd-iso',duration:600,outPath:output,audioPlan:{streams:[{layout:'stereo'}]}};
  const size = BigInt(estimateDeliveryBytes(spec));
  const fake = sameVolume => ({
    stat: async dir => ({dev:sameVolume || dir === queue ? 1n : 2n}),
    statfs: async () => ({bsize:1n,bavail:2n*size}),
  });
  it('同磁碟須同時裝得下原始 MPG、DVD 結構與 ISO，分磁碟分別檢查', async () => {
    await expect(inspectDeliverySpace(spec,queue,fake(true))).resolves.toContain('空間可能不足');
    const summary = await inspectDeliverySpace(spec,queue,fake(false));
    expect(summary).toContain(queue); expect(summary).toContain(path.dirname(output));
  });
  it('已知的 PCM 資料量超過磁碟可用值，入列前即可回報原因', async () => {
    const wav = {...spec,format:'wav',audioPlan:{buses:[{id:'A'}]}};
    await expect(inspectDeliverySpace(wav,queue,{...fake(true),statfs:async()=>({bavail:10n,bsize:1n})}))
      .rejects.toMatchObject({code:'DELIVERY_DISK_SPACE'});
  });
  it('無法查詢 NAS 時顯示未知，其他排程的預估用量與此工作的門檻分開', async () => {
    await expect(inspectDeliverySpace(spec,queue,{stat:async()=>{throw Error('NAS offline');},statfs:async()=>({})}))
      .resolves.toContain('無法查詢剩餘空間');
    const pending = [{...spec,outPath:path.resolve('export','next.iso')}];
    await expect(inspectDeliverySpace(spec,queue,{...fake(false),pending})).resolves.toContain('同磁碟其他交付預估');
  });
});

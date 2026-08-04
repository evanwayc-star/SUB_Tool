/* 匯出工作的准入政策（electron/export-admission.js）。

   這四條規則原本散在 electron/main.js 裡，與 BrowserWindow／dialog／
   ffmpeg spawn 糾纏，vitest 起不了 Electron，因此**一行測試都沒有**——
   而其中一條正是鐵律 §0.8 的守門員。

   壞掉的樣子（全部不會報錯）：
     - 拿 proxy.mp4 匯出 → 成品是 720p 預覽畫質，進度與完成通知一切正常
     - 拿 chNN.m4a 匯出 → 聲道錯組，只有放進播放器才聽得出來
     - 兩份交付寫同一個檔 → 後者覆蓋前者，兩邊都回報成功
     - format 與副檔名不符 → ffmpeg 依副檔名選 muxer，內容與使用者選的格式不同

   對應 docs/技術架構說明.md §0.6（有產出不等於對）與 §0.8。 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createExportAdmission } = require(path.join(ROOT, 'electron/export-admission.js'));

const EXT = { h264: 'mp4', prores: 'mov', wav: 'wav' };

/* 預設全部放行，測哪一條就只關哪一條——才不會因為別的規則先擋下來而假綠。 */
function make(overrides = {}) {
  const jobs = overrides.jobs || [];
  return createExportAdmission({
    expectedExtensionFor: fmt => EXT[fmt] || 'mp4',
    outputKeyFor: p => String(p).toLowerCase(),
    mergeSourcePaths: (payload, sourcePaths) => sourcePaths || payload?.sources || [],
    currentJobs: () => jobs,
    reservesOutput: status => status === 'queued' || status === 'running',
    canReadSource: () => true,
    canWriteDelivery: () => true,
    isPreviewCacheMedia: () => false,
    ...overrides.deps,
  });
}

const job = (over = {}) => ({
  id: 'j1',
  sourcePaths: ['D:/master/a.mxf'],
  ...over,
  payload: { format: 'h264', outPath: 'D:/out/a.mp4', ...(over.payload || {}) },
});

describe('輸出副檔名必須與 format 一致', () => {
  it.each([
    ['h264', 'D:/out/a.mp4'],
    ['prores', 'D:/out/a.mov'],
    ['wav', 'D:/out/a.wav'],
  ])('%s → %s 放行', (format, outPath) => {
    expect(make().assertOutputFormat(job({ payload: { format, outPath } }))).toBe(EXT[format]);
  });

  it('format 與副檔名不符時擋下（ffmpeg 是依副檔名選 muxer 的）', () => {
    expect(() => make().assertOutputFormat(job({ payload: { format: 'prores', outPath: 'D:/out/a.mp4' } })))
      .toThrow(/必須使用 \.mov/);
  });

  it('副檔名比對不分大小寫（Windows 上 .MP4 與 .mp4 是同一個檔）', () => {
    expect(make().assertOutputFormat(job({ payload: { format: 'h264', outPath: 'D:/out/A.MP4' } }))).toBe('mp4');
  });
});

describe('輸出路徑', () => {
  it('缺路徑時丟 INVALID_OUTPUT_PATH，不可以靜靜放過', () => {
    expect(() => make().outputKey(job({ payload: { outPath: '' } })))
      .toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT_PATH' }));
    expect(() => make().outputKey(job({ payload: { outPath: '   ' } })))
      .toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT_PATH' }));
  });
});

describe('同一個輸出檔不可被兩份交付同時佔用', () => {
  it('已有 queued 的同輸出 → OUTPUT_BUSY，並帶出衝突的 job id', () => {
    const existing = { id: 'other', status: 'queued', payload: { outPath: 'D:/out/a.mp4' } };
    let thrown;
    try { make({ jobs: [existing] }).assertOutputAvailable(job()); } catch (e) { thrown = e; }
    expect(thrown?.code).toBe('OUTPUT_BUSY');
    expect(thrown?.conflictingJobId).toBe('other');
  });

  it('已完成／失敗的工作不算佔用（reservesOutput 說了算）', () => {
    const done = { id: 'other', status: 'done', payload: { outPath: 'D:/out/a.mp4' } };
    expect(() => make({ jobs: [done] }).assertOutputAvailable(job())).not.toThrow();
  });

  it('自己不算佔用自己（重試同一份工作時會用到）', () => {
    const self = { id: 'j1', status: 'running', payload: { outPath: 'D:/out/a.mp4' } };
    expect(() => make({ jobs: [self] }).assertOutputAvailable(job())).not.toThrow();
  });

  it('佇列裡有壞資料（無輸出路徑）時跳過它，不可因此整批擋死', () => {
    const broken = { id: 'bad', status: 'queued', payload: {} };
    expect(() => make({ jobs: [broken] }).assertOutputAvailable(job())).not.toThrow();
  });
});

describe('鐵律 §0.8：交付只准讀母素材', () => {
  it('來源是播放快取時擋下', () => {
    const admission = make({ deps: { isPreviewCacheMedia: f => /proxy\.mp4$|ch\d+\.m4a$/i.test(f) } });
    expect(() => admission.assertJobAdmissible(job({ sourcePaths: ['D:/cache/proxy.mp4'] })))
      .toThrow(/不能使用 Proxy 或播放快取/);
    expect(() => admission.assertJobAdmissible(job({ sourcePaths: ['D:/cache/ch03.m4a'] })))
      .toThrow(/不能使用 Proxy 或播放快取/);
  });

  it('母素材放行', () => {
    const admission = make({ deps: { isPreviewCacheMedia: f => /proxy\.mp4$/.test(f) } });
    expect(admission.assertJobAdmissible(job({ sourcePaths: ['D:/master/a.mxf'] })))
      .toEqual(['D:/master/a.mxf']);
  });

  it('多個來源中只要有一個是快取就整份擋下', () => {
    const admission = make({ deps: { isPreviewCacheMedia: f => /proxy\.mp4$/.test(f) } });
    expect(() => admission.assertJobAdmissible(job({ sourcePaths: ['D:/master/a.mxf', 'D:/cache/proxy.mp4'] })))
      .toThrow(/不能使用 Proxy 或播放快取/);
  });
});

describe('檔案能力', () => {
  it('來源未授權 → UNAUTHORIZED_PATH', () => {
    const admission = make({ deps: { canReadSource: () => false } });
    expect(() => admission.assertJobAdmissible(job()))
      .toThrow(expect.objectContaining({ code: 'UNAUTHORIZED_PATH' }));
  });

  it('輸出位置未授權 → UNAUTHORIZED_OUTPUT_PATH', () => {
    const admission = make({ deps: { canWriteDelivery: () => false } });
    expect(() => admission.assertJobAdmissible(job()))
      .toThrow(expect.objectContaining({ code: 'UNAUTHORIZED_OUTPUT_PATH' }));
  });

  it('副檔名先擋：格式不符時不該先去問檔案能力', () => {
    let asked = false;
    const admission = make({ deps: { canReadSource: () => { asked = true; return true; } } });
    expect(() => admission.assertJobAdmissible(job({ payload: { format: 'wav', outPath: 'D:/out/a.mp4' } })))
      .toThrow(/必須使用 \.wav/);
    expect(asked, '格式已經不合法，不該再去查來源能力').toBe(false);
  });
});

describe('模組本身保持可測', () => {
  it('只 require node:path，不碰 electron／fs（否則 vitest 起不動）', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(ROOT, 'electron/export-admission.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const specs = [...src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    expect(specs).toEqual(['path']);
  });
});

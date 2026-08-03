/* 交付清單（delivery-list.js）的規則。

   這支測試的存在本身就是重點：規則從 415 行的 DOM 閉包裡搬出來之後，
   驗證不需要 jsdom、不需要 mock 任何模組，直接呼叫就好。
   對照 tests/deliveryDialog.test.js——那支要 mock 六個模組才動得起來。 */
import { describe, expect, it } from 'vitest';
import {
  createDeliveryList, defaultDeliveryName, deliveryResolution,
  extensionFor, projectTagFrom, suggestKbps,
} from '../src/delivery-list.js';

const base = (over = {}) => createDeliveryList({
  projectTag: '拼桌', fps: 29.97, canvasW: 1920, canvasH: 1080, desktop: true, ...over,
});

describe('副檔名', () => {
  it('依格式決定，未知格式退回 mp4', () => {
    expect(extensionFor('h264')).toBe('.mp4');
    expect(extensionFor('prores')).toBe('.mov');
    expect(extensionFor('wav')).toBe('.wav');
    expect(extensionFor('未知')).toBe('.mp4');
  });
});

describe('專案代號', () => {
  it('去掉副檔名並跳過 ST_／V_ 前綴', () => {
    expect(projectTagFrom('ST_拼桌_29fps.mp4')).toBe('拼桌');
    expect(projectTagFrom('V_專訪_25fps.mov')).toBe('專訪');
    expect(projectTagFrom('訪談.mxf')).toBe('訪談');
  });
  it('沒有素材時給 sequence', () => {
    expect(projectTagFrom(null)).toBe('sequence');
  });
});

describe('預設檔名', () => {
  it('帶入 fps（無條件捨去）與交付解析度', () => {
    expect(defaultDeliveryName({ projectTag: '拼桌', fps: 29.97, format: 'h264', targetH: 1080 }))
      .toBe('ST_拼桌_29fps_1080p.mp4');
  });
  it('targetH=0（來源解析度）不加解析度標記', () => {
    expect(defaultDeliveryName({ projectTag: '拼桌', fps: 25, format: 'h264', targetH: 0 }))
      .toBe('ST_拼桌_25fps.mp4');
  });
  it('WAV 不帶解析度標記', () => {
    expect(defaultDeliveryName({ projectTag: '拼桌', fps: 25, format: 'wav', targetH: 1080 }))
      .toBe('ST_拼桌_25fps.wav');
  });
  it('聲道編組寫進檔名，多條 stream 以 + 相連', () => {
    const audioPlan = { streams: [{ layout: '5.1' }, { layout: 'stereo' }] };
    expect(defaultDeliveryName({ projectTag: '拼桌', fps: 29.97, format: 'h264', targetH: 0, audioPlan }))
      .toBe('ST_拼桌_29fps_51FM+20FM.mp4');
  });
  it('有設定 stream 名稱時，優先使用名稱並移除點與減號（如 ME、雙語）', () => {
    const audioPlan = { streams: [{ layout: 'stereo', name: '2.0-FM' }, { layout: 'stereo', name: '2.0-ME' }] };
    expect(defaultDeliveryName({ projectTag: '拼桌', fps: 25, format: 'h264', targetH: 0, audioPlan }))
      .toBe('ST_拼桌_25fps_20FM+20ME.mp4');
  });
  it('全部皆為 mono 時，統一改用 NCH-Mono', () => {
    const mk = count => defaultDeliveryName({
      projectTag: 'X', fps: 25, format: 'h264', targetH: 0,
      audioPlan: { streams: Array.from({ length: count }).map(() => ({ layout: 'mono' })) },
    });
    expect(mk(1)).toContain('_1CH-Mono');
    expect(mk(8)).toContain('_8CH-Mono');
  });
  it('舊欄位名 groups 也吃得到', () => {
    const audioPlan = { groups: [{ layout: 'mono' }] };
    expect(defaultDeliveryName({ projectTag: 'X', fps: 25, format: 'h264', targetH: 0, audioPlan }))
      .toContain('_1CH-Mono');
  });
});

describe('交付解析度', () => {
  it('targetH=0 沿用專案畫布', () => {
    expect(deliveryResolution({ canvasW: 1920, canvasH: 1080, targetH: 0 })).toEqual({ w: 1920, h: 1080 });
  });
  it('等比縮放到指定高度', () => {
    expect(deliveryResolution({ canvasW: 1920, canvasH: 1080, targetH: 720 })).toEqual({ w: 1280, h: 720 });
  });
  it('寬度一律取偶數（H.264 要求，奇數寬會讓 ffmpeg 直接失敗）', () => {
    // 4:3 → 720 高會算出 960（偶數）；用會產生奇數的比例驗證夾偶
    const r = deliveryResolution({ canvasW: 1919, canvasH: 1080, targetH: 721 });
    expect(r.w % 2).toBe(0);
  });
  it('WAV 不做縮放', () => {
    expect(deliveryResolution({ canvasW: 1920, canvasH: 1080, targetH: 720, isWav: true }))
      .toEqual({ w: 1920, h: 1080 });
  });
});

describe('清單操作', () => {
  it('新列預設一列，並自動帶預設檔名', () => {
    const l = base();
    expect(l.count()).toBe(1);
    expect(l.get(0).customName).toBe('ST_拼桌_29fps.mp4');
  });

  it('audioOnly 時新列預設為 wav', () => {
    const l = base({ audioOnly: true });
    expect(l.get(0).format).toBe('wav');
    expect(l.get(0).customName.endsWith('.wav')).toBe(true);
  });

  it('換格式會換副檔名', () => {
    const l = base();
    l.setFormat(0, 'prores');
    expect(l.get(0).customName).toBe('ST_拼桌_29fps.mov');
  });

  it('使用者改過名字後，換格式只換副檔名、不蓋掉名字', () => {
    const l = base();
    l.setName(0, '客戶指定檔名');
    expect(l.get(0).customName).toBe('客戶指定檔名.mp4');
    l.setFormat(0, 'prores');
    expect(l.get(0).customName).toBe('客戶指定檔名.mov');
  });

  it('沒改過名字的列，換解析度會重新產生檔名', () => {
    const l = base();
    l.setTargetHeight(0, 720);
    expect(l.get(0).customName).toBe('ST_拼桌_29fps_720p.mp4');
  });

  it('換解析度會一併更新 H.264 的建議碼率', () => {
    const l = base();
    const before = l.get(0).kbps;
    l.setTargetHeight(0, 720);
    expect(l.get(0).kbps).toBe(suggestKbps({ w: 1280, h: 720 }));
    expect(l.get(0).kbps).not.toBe(before);
  });

  it('把名字改回等同預設值時，視為沒有自訂', () => {
    const l = base();
    l.setName(0, '亂打');
    l.setName(0, 'ST_拼桌_29fps.mp4');
    l.setTargetHeight(0, 720);
    expect(l.get(0).customName).toBe('ST_拼桌_29fps_720p.mp4');
  });

  it('補副檔名時不區分大小寫，不會重複附加', () => {
    const l = base();
    l.setName(0, '交付.MP4');
    expect(l.get(0).customName).toBe('交付.MP4');
  });

  it('新增列會沿用上一列的輸出目錄，但清掉檔名重新產生', () => {
    const l = base();
    l.setOutDir(0, 'D:\\交付');
    l.setFormat(0, 'prores');
    const added = l.add();
    expect(added.outDir).toBe('D:\\交付');
    expect(added.format).toBe('prores');
    expect(added.customName).toBe('ST_拼桌_29fps.mov');
  });

  it('刪除列', () => {
    const l = base();
    l.add();
    expect(l.count()).toBe(2);
    l.removeAt(0);
    expect(l.count()).toBe(1);
  });
});

describe('驗證規則', () => {
  const codes = l => l.problems().map(p => p.code);

  it('缺輸出目錄會擋下（桌面版）', () => {
    const l = base();
    expect(codes(l)).toContain('missing-dir');
  });

  it('網頁版不要求輸出目錄', () => {
    const l = base({ desktop: false });
    expect(codes(l)).not.toContain('missing-dir');
    expect(l.problems()).toHaveLength(0);
  });

  it('缺檔名會擋下', () => {
    const l = base();
    l.setOutDir(0, 'D:\\交付');
    l.setName(0, '');
    expect(codes(l)).toContain('missing-name');
  });

  it('同一目錄內重複檔名會擋下', () => {
    const l = base();
    l.setOutDir(0, 'D:\\交付');
    l.add();
    l.setOutDir(1, 'D:\\交付');
    expect(codes(l)).toContain('duplicate-path');
  });

  it('同名但不同目錄是合法的——不可誤擋', () => {
    const l = base();
    l.setOutDir(0, 'D:\\交付A');
    l.add();
    l.setOutDir(1, 'D:\\交付B');
    expect(codes(l)).not.toContain('duplicate-path');
    expect(l.problems()).toHaveLength(0);
  });

  it('重複檔名的比對不分大小寫（Windows 檔案系統）', () => {
    const l = base();
    l.setOutDir(0, 'D:\\交付');
    l.add();
    l.setOutDir(1, 'd:\\交付');
    l.setName(1, l.get(0).customName.toUpperCase());
    expect(codes(l)).toContain('duplicate-path');
  });

  it('全部填好就沒有問題', () => {
    const l = base();
    l.setOutDir(0, 'D:\\交付');
    expect(l.problems()).toHaveLength(0);
  });
});

describe('轉成匯出工作', () => {
  const snapshot = {
    clips: [{ name: 'a.mov' }],
    videoTracks: [{ vt: 0 }],
    duration: 36,
    assText: '[Script Info]',
    timelineStartTimecode: '00:00:10:00',
    compiledAudioPlan: { streams: [] },
  };

  it('每一列各產生一份匯出工作，輸出路徑由目錄與檔名組出', () => {
    const l = base();
    l.setOutDir(0, 'D:\\交付\\');
    const [job] = l.toJobs(snapshot);
    expect(job.outPath).toBe('D:\\交付\\ST_拼桌_29fps.mp4');
    expect(job.defaultName).toBe('ST_拼桌_29fps.mp4');
  });

  it('macOS 輸出目錄使用 POSIX 斜線，不可混入 Windows 反斜線', () => {
    const l = base();
    l.setOutDir(0, '/Users/evan/Movies/SUBTool_Output/');
    const [job] = l.toJobs(snapshot);
    expect(job.outPath).toBe('/Users/evan/Movies/SUBTool_Output/ST_拼桌_29fps.mp4');
    expect(job.outPath).not.toContain('\\');
  });

  it('POSIX 根目錄與 Windows 磁碟根目錄都只保留一個分隔符', () => {
    const posix = base();
    posix.setOutDir(0, '/');
    expect(posix.toJobs(snapshot)[0].outPath).toBe('/ST_拼桌_29fps.mp4');

    const windows = base();
    windows.setOutDir(0, 'D:\\');
    expect(windows.toJobs(snapshot)[0].outPath).toBe('D:\\ST_拼桌_29fps.mp4');
  });

  it('交付解析度走同一條公式', () => {
    const l = base();
    l.setOutDir(0, 'D:\\交付');
    l.setTargetHeight(0, 720);
    const [job] = l.toJobs(snapshot);
    expect({ w: job.width, h: job.height }).toEqual({ w: 1280, h: 720 });
  });

  it('燒入 TC 才會帶 timecodeWatermark，且帶的是時間軸起點', () => {
    const l = base();
    l.setOutDir(0, 'D:\\交付');
    expect(l.toJobs(snapshot)[0].timecodeWatermark).toBeNull();
    l.setBurnTimecode(0, true);
    expect(l.toJobs(snapshot)[0].timecodeWatermark).toEqual({ start: '00:00:10:00' });
  });

  it('WAV 不燒 TC，即使勾了也一樣', () => {
    const l = base();
    l.setOutDir(0, 'D:\\交付');
    l.setBurnTimecode(0, true);
    l.setFormat(0, 'wav');
    expect(l.toJobs(snapshot)[0].timecodeWatermark).toBeNull();
  });

  it('WAV 不縮放，維持專案畫布尺寸', () => {
    const l = base();
    l.setOutDir(0, 'D:\\交付');
    l.setTargetHeight(0, 720);
    l.setFormat(0, 'wav');
    const [job] = l.toJobs(snapshot);
    expect({ w: job.width, h: job.height }).toEqual({ w: 1920, h: 1080 });
  });

  it('音訊編組交給呼叫端傳進來的合成函式', () => {
    const l = base();
    l.setOutDir(0, 'D:\\交付');
    const composeAudioPlan = (compiled, row) => ({ compiled, format: row.format });
    const [job] = l.toJobs({ ...snapshot, composeAudioPlan });
    expect(job.audioPlan).toEqual({ compiled: { streams: [] }, format: 'h264' });
  });
});

/* 交付清單（delivery-list.js）的規則。

   這支測試的存在本身就是重點：規則從 415 行的 DOM 閉包裡搬出來之後，
   驗證不需要 jsdom、不需要 mock 任何模組，直接呼叫就好。
   對照 tests/deliveryDialog.test.js——那支要 mock 六個模組才動得起來。 */
import { describe, expect, it } from 'vitest';
import { deliveryOutputNames, deliveryPresetAudioProblem } from '../shared/delivery-formats.cjs';
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
    expect(extensionFor('mod-fhd')).toBe('.ts');
    expect(extensionFor('airline-s3k')).toBe('.mpg');
    expect(extensionFor('airline-dmpes')).toBe('.mpg');
    expect(extensionFor('未知')).toBe('.mp4');
  });
});

describe('專案代號', () => {
  it('去掉副檔名並跳過 ST_／V_ 前綴', () => {
    expect(projectTagFrom('ST_拼桌_29.97fps.mp4')).toBe('拼桌');
    expect(projectTagFrom('V_專訪_25fps.mov')).toBe('專訪');
    expect(projectTagFrom('訪談.mxf')).toBe('訪談');
  });
  it('沒有素材時給 sequence', () => {
    expect(projectTagFrom(null)).toBe('sequence');
  });
});

describe('預設檔名', () => {
  it('帶入完整 fps（保留小數）與交付解析度', () => {
    expect(defaultDeliveryName({ projectTag: '拼桌', fps: 29.97, format: 'h264', targetH: 1080 }))
      .toBe('ST_拼桌_29.97fps_1080p.mp4');
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
      .toBe('ST_拼桌_29.97fps_51FM+20FM.mp4');
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
    expect(l.get(0).customName).toBe('ST_拼桌_29.97fps.mp4');
  });

  it('audioOnly 時新列預設為 wav', () => {
    const l = base({ audioOnly: true });
    expect(l.get(0).format).toBe('wav');
    expect(l.get(0).customName.endsWith('.wav')).toBe(true);
  });

  it('換格式會換副檔名', () => {
    const l = base();
    l.setFormat(0, 'prores');
    expect(l.get(0).customName).toBe('ST_拼桌_29.97fps.mov');
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
    expect(l.get(0).customName).toBe('ST_拼桌_29.97fps_720p.mp4');
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
    l.setName(0, 'ST_拼桌_29.97fps.mp4');
    l.setTargetHeight(0, 720);
    expect(l.get(0).customName).toBe('ST_拼桌_29.97fps_720p.mp4');
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
    expect(added.customName).toBe('ST_拼桌_29.97fps.mov');
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
    expect(job.outPath).toBe('D:\\交付\\ST_拼桌_29.97fps.mp4');
    expect(job.defaultName).toBe('ST_拼桌_29.97fps.mp4');
  });

  it('macOS 輸出目錄使用 POSIX 斜線，不可混入 Windows 反斜線', () => {
    const l = base();
    l.setOutDir(0, '/Users/evan/Movies/SUBTool_Output/');
    const [job] = l.toJobs(snapshot);
    expect(job.outPath).toBe('/Users/evan/Movies/SUBTool_Output/ST_拼桌_29.97fps.mp4');
    expect(job.outPath).not.toContain('\\');
  });

  it('POSIX 根目錄與 Windows 磁碟根目錄都只保留一個分隔符', () => {
    const posix = base();
    posix.setOutDir(0, '/');
    expect(posix.toJobs(snapshot)[0].outPath).toBe('/ST_拼桌_29.97fps.mp4');

    const windows = base();
    windows.setOutDir(0, 'D:\\');
    expect(windows.toJobs(snapshot)[0].outPath).toBe('D:\\ST_拼桌_29.97fps.mp4');
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

describe('航空 MPEG-TS 交付', () => {
  const stereoPlan = { streams: [{ layout: 'stereo', busIds: ['l', 'r'] }] };

  it.each([
    ['airline-s3k', '航空-S3K', 352, 240],
    ['airline-dmpes', '航空-DMPES', 720, 480],
  ])('%s 固定規格與檔名，只列出最終 mpg 成品供檢查覆寫', (format, label, width, height) => {
    const list = base({ fps: 24, canvasW: 4096, canvasH: 2160, defaultAudioLayout: stereoPlan });
    list.setOutDir(0, 'D:\\交付');
    list.setFormat(0, format);
    list.setTargetHeight(0, 720);
    list.setTargetFps(0, 60);
    list.setKbps(0, 20000);
    expect(list.get(0)).toMatchObject({ targetH: height, targetFps: 29.97, kbps: 1500 });
    const stem = `ST_拼桌_${label}_${height}p_29.97fps`;
    expect(list.get(0).customName).toBe(stem + '.mpg');
    expect(list.outPaths()).toEqual([{
      dir: 'D:\\交付', name: stem + '.mpg', path: `D:\\交付\\${stem}.mpg`,
    }]);
    const [job] = list.toJobs({
      clips: [], videoTracks: [], duration: 12.5, compiledAudioPlan: stereoPlan,
      timecodeForFps: fps => `fps:${fps}`,
    });
    expect(job).toMatchObject({ format, width, height, fps: 29.97, videoKbps: 1500, duration: 12.5 });
    list.setBurnTimecode(0, true);
    expect(list.outPaths().every(output => output.name.startsWith(stem + '_TC.'))).toBe(true);
  });

  it('S3K 與 DMPES 使用同一成品檔名時會阻擋輸出碰撞', () => {
    const list = base({ defaultAudioLayout: stereoPlan });
    list.setOutDir(0, 'D:\\交付');
    list.setFormat(0, 'airline-s3k');
    list.setName(0, '節目');
    list.add();
    list.setFormat(1, 'airline-dmpes');
    list.setName(1, '節目');
    expect(list.problems().map(problem => problem.code)).toContain('duplicate-path');
    list.setOutDir(1, 'D:\\另一批');
    expect(list.problems()).toHaveLength(0);
  });

  it('各格式只保留成品檔名，不建立同名音訊或設定檔', () => {
    expect(deliveryOutputNames('airline-s3k', '節目.v2.MPG'))
      .toEqual(['節目.v2.MPG']);
    expect(deliveryOutputNames('airline-dmpes', 'film.mpg'))
      .toEqual(['film.mpg']);
    expect(deliveryOutputNames('mod-fhd', 'film.ts')).toEqual(['film.ts']);
    expect(deliveryOutputNames('h264', 'film.mp4')).toEqual(['film.mp4']);
  });

  it('多串流阻擋訊息使用各航空格式名稱，兩條 mono 仍依使用者次序編成 Stereo', () => {
    expect(deliveryPresetAudioProblem('airline-s3k', { streams: [] })).toContain('航空-S3K 需要單一 Stereo');
    expect(deliveryPresetAudioProblem('airline-dmpes', { streams: [] })).toContain('航空-DMPES 需要單一 Stereo');
    const list = base({ defaultAudioLayout: { streams: [
      { layout: 'mono', busIds: ['r'] }, { layout: 'mono', busIds: ['l'] },
    ] } });
    list.setFormat(0, 'airline-s3k');
    expect(list.get(0).audioPlan.streams).toEqual([{
      id: 'airline-s3k-stereo', name: '航空-S3K Stereo', layout: 'stereo', busIds: ['r', 'l'],
    }]);
  });
});

describe('MOD-FHD 固定交付規格', () => {
  const stereoPlan = { streams: [{ layout: 'stereo', busIds: ['mix-l', 'mix-r'] }] };
  const monoPlan = { streams: [
    { layout: 'mono', busIds: ['mix-r'] },
    { layout: 'mono', busIds: ['mix-l'] },
  ] };
  const snapshot = {
    clips: [{ name: 'master.mov' }], videoTracks: [], duration: 12,
    assText: '[Script Info]', compiledAudioPlan: stereoPlan,
    timecodeForFps: fps => fps === 29.97 ? '01:00:00;00' : '01:00:00:00',
  };

  it('檔名標示 MOD-FHD 與 1080i，與專案 FPS、畫布和編組名稱無關', () => {
    expect(defaultDeliveryName({
      projectTag: '節目', fps: 24, format: 'mod-fhd', targetH: 720, audioPlan: stereoPlan,
    })).toBe('ST_節目_MOD-FHD_1080i_29.97fps.ts');
    expect(defaultDeliveryName({
      projectTag: '節目', fps: 24, format: 'mod-fhd', burnTimecode: true,
    })).toBe('ST_節目_MOD-FHD_1080i_29.97fps_TC.ts');
  });

  it('選格式後固定解析度、FPS、碼率，編輯入口不能覆寫', () => {
    const list = base({ fps: 24, canvasW: 4096, canvasH: 2160 });
    list.setFormat(0, 'mod-fhd');
    list.setTargetHeight(0, 720);
    list.setTargetFps(0, 60);
    list.setKbps(0, 20000);
    expect(list.get(0)).toMatchObject({ targetH: 1080, targetFps: 29.97, kbps: 7280 });
    expect(list.get(0).customName).toBe('ST_拼桌_MOD-FHD_1080i_29.97fps.ts');
  });

  it('自訂檔名換成 ts，TC 仍可切換', () => {
    const list = base();
    list.setName(0, '客戶交付');
    list.setFormat(0, 'mod-fhd');
    list.setBurnTimecode(0, true);
    expect(list.get(0).customName).toBe('客戶交付_TC.ts');
    list.setBurnTimecode(0, false);
    expect(list.get(0).customName).toBe('客戶交付.ts');
  });

  it('雙 Mono 依原 bus 順序合成 Stereo，不改動專案的預設編組', () => {
    const list = base({ defaultAudioLayout: monoPlan });
    list.setFormat(0, 'mod-fhd');
    expect(list.get(0).audioPlan.streams).toEqual([
      expect.objectContaining({ layout: 'stereo', busIds: ['mix-r', 'mix-l'] }),
    ]);
    expect(monoPlan.streams.map(stream => stream.layout)).toEqual(['mono', 'mono']);
  });

  it('折返草稿與套用音軌設定時也會固定規格並合併雙 Mono', () => {
    const list = base({ initial: [{ format: 'mod-fhd', targetH: 720, targetFps: 24, kbps: 10, audioPlan: monoPlan }] });
    expect(list.get(0)).toMatchObject({ targetH: 1080, targetFps: 29.97, kbps: 7280 });
    expect(list.get(0).audioPlan.streams).toHaveLength(1);
    list.applyRow(0, { ...list.get(0), targetH: 480, targetFps: 25, kbps: 50, audioPlan: monoPlan });
    expect(list.get(0)).toMatchObject({ targetH: 1080, targetFps: 29.97, kbps: 7280 });
    expect(list.get(0).audioPlan.streams[0].busIds).toEqual(['mix-r', 'mix-l']);
  });

  it.each([
    { streams: [{ layout: '5.1', busIds: ['l', 'r', 'c', 'lfe', 'ls', 'rs'] }] },
    { streams: [...stereoPlan.streams, { layout: 'stereo', busIds: ['me-l', 'me-r'] }] },
  ])('不默默捨棄不相容音訊，而是阻擋並要求選兩條專案音軌：%j', audioPlan => {
    const list = base({ defaultAudioLayout: audioPlan });
    list.setOutDir(0, 'D:/交付');
    list.setFormat(0, 'mod-fhd');
    expect(list.get(0).audioPlan).toEqual(audioPlan);
    expect(list.problems()).toEqual([
      expect.objectContaining({ kind: 'blocking', code: 'preset-audio', index: 0, message: expect.stringContaining('單一 Stereo') }),
    ]);
  });

  it('交付工作使用固定尺寸與 FPS 的時間碼，即使 live row 被直接改寫', () => {
    const list = base({ fps: 24, canvasW: 4096, canvasH: 2160, defaultAudioLayout: stereoPlan });
    list.setOutDir(0, 'D:/交付');
    list.setFormat(0, 'mod-fhd');
    list.setBurnTimecode(0, true);
    Object.assign(list.get(0), { targetH: 480, targetFps: 60, kbps: 20000 });
    expect(list.toJobs(snapshot)[0]).toMatchObject({
      format: 'mod-fhd', width: 1920, height: 1080, targetH: 1080, fps: 29.97, videoKbps: 7280,
      canvasW: 4096, canvasH: 2160,
      timelineStartTimecode: '01:00:00;00', timecodeWatermark: { start: '01:00:00;00' },
      outPath: 'D:/交付/ST_拼桌_MOD-FHD_1080i_29.97fps_TC.ts',
    });
  });

  it('工作合成後再次合併雙 Mono，拒絕不相容的實際音訊計畫', () => {
    const list = base({ defaultAudioLayout: stereoPlan });
    list.setFormat(0, 'mod-fhd');
    const job = list.toJobs({ ...snapshot, composeAudioPlan: () => monoPlan })[0];
    expect(job.audioPlan.streams).toEqual([
      expect.objectContaining({ layout: 'stereo', busIds: ['mix-r', 'mix-l'] }),
    ]);
    const surround = { streams: [{ layout: '5.1', busIds: ['l', 'r', 'c', 'lfe', 'ls', 'rs'] }] };
    expect(() => list.toJobs({ ...snapshot, composeAudioPlan: () => surround })).toThrow('單一 Stereo');
  });
});

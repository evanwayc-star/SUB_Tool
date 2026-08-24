import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  escapeFfmpegFilterPath,
  buildSubtitlesFilter,
  buildScaleAndPadFilter,
} = require('../shared/export-filtergraph-planner.cjs');


describe('export-filtergraph-planner', () => {
  it('嚴格遵守鐵律 §0.4：Windows 路徑雙層跳脫 (C\\\\:/...)', () => {
    const winPath = 'C:\\Projects\\SUB Tool\\sub.ass';
    const escaped = escapeFfmpegFilterPath(winPath);
    expect(escaped).toBe('C\\\\:/Projects/SUB Tool/sub.ass');
  });

  it('產生標準 ASS 字幕燒錄 filtergraph 字串', () => {
    const filter = buildSubtitlesFilter('C:\\test.ass', 'C:\\fonts');
    expect(filter).toBe("subtitles='C\\\\:/test.ass':fontsdir='C\\\\:/fonts'");
  });

  it('產生等比縮放與留黑邊 filtergraph', () => {
    // 相同解析度回傳 null
    expect(buildScaleAndPadFilter(1920, 1080, 1920, 1080)).toBe('null');

    // 1280x720 縮放到 1920x1080
    const filter = buildScaleAndPadFilter(1280, 720, 1920, 1080);
    expect(filter).toContain('scale=1920:1080');
    expect(filter).toContain('pad=1920:1080');
  });
});

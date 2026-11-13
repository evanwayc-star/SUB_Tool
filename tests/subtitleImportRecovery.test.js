import { describe, expect, it } from 'vitest';
import { SubFormats } from '../src/formats.js';

describe('部分缺少時間碼的字幕匯入', () => {
  it('Encore 保留開頭與中間無碼原文，問題附來源行數，重新匯出為未定時標記', () => {
    const parsed = SubFormats.parseEncore('開場原文\n第二句原文\n\n00:00:01:00 00:00:02:00 有時間碼\n中間缺少時間碼\n00:00:03:00 00:00:04:00 最後一句', 24);
    expect(parsed.map(cue => cue.text)).toEqual(['開場原文', '第二句原文', '有時間碼', '中間缺少時間碼', '最後一句']);
    expect(parsed.filter(cue => cue.timed === false).map(cue => cue.text)).toEqual(['開場原文', '第二句原文', '中間缺少時間碼']);
    expect(parsed.issues.map(issue => ({line:issue.line,code:issue.code}))).toEqual([
      {line:1,code:'missing-timecode'}, {line:2,code:'missing-timecode'}, {line:5,code:'missing-timecode'},
    ]);
    expect(SubFormats.toEncore(parsed, 24)).toContain('--:--:--:-- --:--:--:-- 開場原文');
    expect(SubFormats.toEncore(parsed, 24)).toContain('00:00:01:00 00:00:02:00 有時間碼');
  });

  it('Encore 無效影格、倒序、缺單側與空文均指出原始行，不把錯誤時間修成有效字幕', () => {
    const parsed = SubFormats.parseEncore('00:00:01:24 00:00:02:00 超出格率\n00:00:03:00 00:00:02:00 倒序\n00:00:03:00 --:--:--:-- 缺結束\n00:00:04:00 00:00:05:00\n00:00:06:00 00:00:07:00 正常', 24);
    expect(parsed).toHaveLength(5);
    expect(parsed.slice(0, 3).every(cue => cue.timed === false)).toBe(true);
    expect(parsed.map(cue => cue.text)).toEqual(['超出格率', '倒序', '缺結束', '', '正常']);
    expect(parsed.issues.map(issue => ({line:issue.line,code:issue.code}))).toEqual([
      {line:1,code:'invalid-timecode'}, {line:2,code:'invalid-range'},
      {line:3,code:'incomplete-timecode'}, {line:4,code:'empty-text'},
    ]);
    expect(parsed.issues[0].source).toContain('00:00:01:24');
    expect(parsed[4]).toMatchObject({start:6,end:7});
  });

  it('SRT 不略過缺時間碼區塊，壞時間碼保留文字並列出來源行', () => {
    const parsed=SubFormats.parseSRT('開頭原文\n仍是原文\n\n1\n00:00:01,000 --> 00:00:02,000\n正常\n\n2\n00:70:03,000 --> 00:00:04,000\n壞時間碼\n\n2025');
    expect(parsed.map(cue=>cue.text)).toEqual(['開頭原文\n仍是原文','正常','壞時間碼','2025']);
    expect(parsed.filter(cue=>cue.timed===false).map(cue=>cue.text)).toEqual(['開頭原文\n仍是原文','壞時間碼','2025']);
    expect(parsed.issues.map(issue=>issue.line)).toEqual([1,9,12]);
  });

  it('SRT 同一時間碼行有多個箭頭時警告並保留正文，不默取前兩段為有效時間',()=>{
    const timing='00:00:01,000 --> 00:00:02,000 --> 00:00:03,000';
    const parsed=SubFormats.parseSRT(`1\n${timing}\n保留第一行\n保留第二行\n\n2\n00:00:04,000 --> 00:00:05,000\n正常`);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({text:'保留第一行\n保留第二行',timed:false});
    expect(parsed.issues).toMatchObject([{line:2,cue:1,code:'invalid-timecode',source:timing}]);
    expect(parsed[1]).toMatchObject({start:4,end:5,text:'正常'});
  });

  it('ASS 無效 Dialogue 時間及缺欄內容保留且警告，不靜默變成 0 秒', () => {
    const parsed=SubFormats.parseASS('[Events]\nDialogue: 0,bad,0:00:02.00,Default,,0,0,0,,失效起點\nDialogue: 原始損壞列\nDialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,正常');
    expect(parsed.map(cue=>cue.text)).toEqual(['失效起點','原始損壞列','正常']);
    expect(parsed.slice(0,2).every(cue=>cue.timed===false)).toBe(true);
    expect(parsed.issues.map(issue=>issue.line)).toEqual([2,3]);
  });

  it('損壞的 ASS 無損補充資料明確警告，仍可保留標準 Dialogue',()=>{
    const parsed=SubFormats.parseASS('[Script Info]\n; SUBTOOL-META:1:1/2:broken\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,保留');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('保留');
    expect(parsed.issues).toMatchObject([{line:2,code:'invalid-metadata'}]);
  });
});

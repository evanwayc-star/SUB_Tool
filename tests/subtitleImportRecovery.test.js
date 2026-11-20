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

  it('行首 Tab 是一整句未定時字幕，僅句內換行記號續行', () => {
    const rows = [
      '\t開場',
      '00:00:01:00 00:00:02:00 第一行//第二行',
      '\t兩詞 之間 ',
      '\t\t另一句//同句第二行',
      '\t ',
      '00:00:03:00 00:00:04:00 收尾',
    ];
    const explicit = [
      '--:--:--:-- --:--:--:-- 開場',
      rows[1],
      '--:--:--:-- --:--:--:-- 兩詞 之間',
      '--:--:--:-- --:--:--:-- 另一句//同句第二行',
      rows[5],
    ];
    const parsed = SubFormats.parseEncore(rows.join('\r\n'), 24);
    expect(parsed.issues).toEqual([]);
    expect(parsed).toEqual(SubFormats.parseEncore(explicit.join('\r\n'), 24));
    expect(parsed.map(cue => cue.text)).toEqual(['開場', '第一行\n第二行', '兩詞 之間', '另一句\n同句第二行', '收尾']);
    expect(parsed.filter(cue => cue.timed === false).map(cue => [cue.start, cue.end])).toEqual([[0, 0], [2, 2], [2, 2]]);
  });

  it('Encore 的 OUT 與正文之間可使用 Tab 或空格，句中空格保留', () => {
    const timing='00:01:15:11 00:01:17:05', text='第一組 第二組';
    const expected=SubFormats.parseEncore(timing+' '+text,24);
    for(const separator of ['\t',' \t','\t\t']){
      const parsed=SubFormats.parseEncore(timing+separator+text+' ',24);
      expect(parsed.issues).toEqual([]);
      expect(parsed).toEqual(expected);
      expect(SubFormats.toEncore(parsed,24)).toBe(timing+' '+text+'\r\n');
    }
  });

  it('Tab 後的時間碼照常驗證，保留來源行號與不完整的原文', () => {
    const rows = [
      '\t00:00:01:00\t00:00:02:00\t有效',
      '\t00:00:02:25 00:00:03:00 無效影格',
      '\t00:00:03:00 --:--:--:-- 缺結束',
      '\t00:00:04:00 只剩開始時間',
      '\t正常未定時',
    ];
    const parsed = SubFormats.parseEncore(rows.join('\n'), 24);
    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toMatchObject({start: 1, end: 2, text: '有效'});
    expect(parsed.slice(1).every(cue => cue.timed === false)).toBe(true);
    expect(parsed.issues.map(({line, source}) => [line, source])).toEqual([[2, rows[1]], [3, rows[2]], [4, rows[3]]]);
    expect(parsed[3].text).toContain('只剩開始時間');
  });

  it('未定時正文夾有一對時碼時，保留整句並提示原始行號', () => {
    const body = '先說這句 00:00:05:10 00:00:06:12 後面還有字';
    const rows = ['00:00:01:00 00:00:02:00 正常', '', '\t' + body, '--:--:--:-- --:--:--:-- ' + body];
    const parsed = SubFormats.parseEncore(rows.join('\n'), 24);
    const untimed = {start: 2, end: 2, text: body, timed: false};
    expect(parsed.slice(1)).toEqual([untimed, untimed]);
    expect(parsed.issues).toMatchObject([
      {code: 'embedded-timecode', line: 3, cue: 2, source: rows[2]},
      {code: 'embedded-timecode', line: 4, cue: 3, source: rows[3]},
    ]);
  });

  it('Encore 無效影格、倒序、缺單側與空文均指出原始行，不把錯誤時間修成有效字幕', () => {
    const parsed = SubFormats.parseEncore('00:00:01:25 00:00:02:00 超出格率\n00:00:03:00 00:00:02:00 倒序\n00:00:03:00 --:--:--:-- 缺結束\n00:00:04:00 00:00:05:00\n00:00:06:00 00:00:07:00 正常', 24);
    expect(parsed).toHaveLength(5);
    expect(parsed.slice(0, 3).every(cue => cue.timed === false)).toBe(true);
    expect(parsed.map(cue => cue.text)).toEqual(['超出格率', '倒序', '缺結束', '', '正常']);
    expect(parsed.issues.map(issue => ({line:issue.line,code:issue.code}))).toEqual([
      {line:1,code:'invalid-timecode'}, {line:2,code:'invalid-range'},
      {line:3,code:'incomplete-timecode'}, {line:4,code:'empty-text'},
    ]);
    expect(parsed.issues[0].source).toContain('00:00:01:25');
    expect(parsed[4]).toMatchObject({start:6,end:7});
  });

  it('24 fps 的 IN 和 OUT 在第 24 格進位，轉分鐘及小時後仍相鄰', () => {
    const rows = [
      '00:00:55:24 00:00:59:24 第一句',
      '00:01:00:00 00:59:59:24 第二句',
      '01:00:00:00 01:00:00:01 第三句',
    ];
    const parsed = SubFormats.parseEncore(rows.join('\n'), 24);
    expect(parsed.issues).toEqual([]);
    expect(parsed.map(cue => [cue.start, cue.end])).toEqual([[56, 60], [60, 3600], [3600, 3600 + 1 / 24]]);
    expect(SubFormats.toEncore(parsed, 24).trimEnd().split('\r\n')).toEqual([
      '00:00:56:00 00:01:00:00 第一句',
      '00:01:00:00 01:00:00:00 第二句',
      rows[2],
    ]);
    const at25 = SubFormats.parseEncore(rows[0], 25);
    expect(at25.issues).toEqual([]);
    expect(SubFormats.toEncore(at25, 25).trimEnd()).toBe(rows[0]);
  });

  it('進位後起訖相等仍提示該行的範圍無效', () => {
    const row = '00:00:55:24 00:00:56:00 相同端點';
    const parsed = SubFormats.parseEncore('\n' + row, 24);
    expect(parsed[0]).toMatchObject({text: '相同端點', timed: false});
    expect(parsed.issues).toMatchObject([{line: 2, code: 'invalid-range', source: row}]);
  });

  it.each([
    [23.976, 24, 24000 / 1001],
    [29.97, 30, 30000 / 1001],
  ])('%s NDF 以名義每秒格數進位並落在精確格網', (fps, base, exact) => {
    const parsed = SubFormats.parseEncore(`00:59:59:${base} 01:00:00:01 一格`, fps);
    expect(parsed.issues).toEqual([]);
    expect(parsed[0].start).toBeCloseTo(3600 * base / exact, 10);
    expect(parsed[0].end).toBeCloseTo((3600 * base + 1) / exact, 10);
    expect(SubFormats.toEncore(parsed, fps)).toBe('01:00:00:00 01:00:00:01 一格\r\n');
  });

  it('29.97 DF 進位到下一個有效格，直接填入被跳過的格號仍列為問題', () => {
    const rows = [
      '00:00:59;30 00:01:00;03 跨第一分鐘',
      '00:09:59;29 00:09:59;30 跨第十分鐘',
      '00:01:00;00 00:01:00;03 跳號零',
      '00:01:00;01 00:01:00;03 跳號一',
    ];
    const parsed = SubFormats.parseEncore(rows.join('\n'), 29.97, true);
    expect(parsed.issues.map(({line, code}) => [line, code])).toEqual([[3, 'invalid-timecode'], [4, 'invalid-timecode']]);
    const exact = 30000 / 1001;
    for (const [index, startFrame, endFrame] of [[0, 1800, 1801], [1, 17981, 17982]]) {
      expect(parsed[index].start).toBeCloseTo(startFrame / exact, 10);
      expect(parsed[index].end).toBeCloseTo(endFrame / exact, 10);
    }
    expect(SubFormats.toEncore(parsed, 29.97, true).trimEnd().split('\r\n')).toEqual([
      '00:01:00;02 00:01:00;03 跨第一分鐘',
      '00:09:59;29 00:10:00;00 跨第十分鐘',
      '--:--:--:-- --:--:--:-- 跳號零',
      '--:--:--:-- --:--:--:-- 跳號一',
    ]);
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

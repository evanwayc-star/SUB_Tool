/* 最小化 XLSX 產生器（Store-mode ZIP + 純文字格）
   支援多分頁（每軌一頁），所有欄位強制文字格式（numFmtId=49 "@"）。
   無外部依賴，純前端可用。 */
import { secToEncore } from './time.js';

/* ---- CRC-32（ZIP 必要）---- */
const _crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = _crc32Table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---- UTF-8 ---- */
const _enc = new TextEncoder();
const utf8 = s => _enc.encode(s);

/* ---- Store-mode ZIP（壓縮方式=0，無 deflate）---- */
function buildZip(files) {
  const localParts = []; // 每個項目：[localHeader, data]
  const cdEntries = [];  // 中央目錄
  const offsets = [];    // 每個檔案的本地 header 偏移
  let pos = 0;

  for (const { name, data } of files) {
    const nameB = utf8(name);
    const sz = data.length;
    const crc = crc32(data);

    // Local file header (30 bytes + name)
    const lh = new Uint8Array(30 + nameB.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034B50, true); // signature
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0x0800, true);      // UTF-8 filename flag
    lv.setUint16(8, 0, true);           // store (no compression)
    lv.setUint16(10, 0, true);          // mod time
    lv.setUint16(12, 0, true);          // mod date
    lv.setUint32(14, crc, true);        // CRC-32
    lv.setUint32(18, sz, true);         // compressed size
    lv.setUint32(22, sz, true);         // uncompressed size
    lv.setUint16(26, nameB.length, true);
    lv.setUint16(28, 0, true);          // extra field length
    lh.set(nameB, 30);

    offsets.push(pos);
    localParts.push(lh, data);
    pos += lh.length + sz;

    // Central directory entry (46 bytes + name)
    const cd = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014B50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, sz, true);
    cv.setUint32(24, sz, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offsets[offsets.length - 1], true); // offset of local header
    cd.set(nameB, 46);
    cdEntries.push(cd);
  }

  const cdOffset = pos;
  const cdSize = cdEntries.reduce((s, c) => s + c.length, 0);

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054B50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);

  const allParts = [...localParts, ...cdEntries, eocd];
  const total = allParts.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of allParts) { out.set(b, off); off += b.length; }
  return out;
}

/* ---- XML helpers ---- */
function xmlEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ---- XLSX XML 組件 ---- */
function contentTypesXml(n) {
  const overrides = Array.from({ length: n }, (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + overrides
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + `</Types>`;
}

function relsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `</Relationships>`;
}

function workbookXml(sheetNames) {
  const sheets = sheetNames.map((name, i) =>
    `<sheet name="${xmlEsc(name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${sheets}</sheets>`
    + `</workbook>`;
}

function workbookRelsXml(n) {
  const sheetRels = Array.from({ length: n }, (_, i) =>
    `<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + sheetRels
    + `<Relationship Id="rId${n+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + `</Relationships>`;
}

function stylesXml() {
  // 樣式對照範本：標頭黃底紅粗字四邊框，資料列左右框無底色
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    // 字型 0=Arial 正常黑（資料）  1=Arial 粗體紅（標頭）
    + `<fonts count="2">`
    + `<font><sz val="11"/><name val="Arial"/><family val="2"/></font>`
    + `<font><b/><sz val="11"/><color rgb="FFFF0000"/><name val="Arial"/><family val="2"/></font>`
    + `</fonts>`
    // 填色 0=無  1=gray125保留  2=黃色#FFFF00（標頭底色）
    + `<fills count="3">`
    + `<fill><patternFill patternType="none"/></fill>`
    + `<fill><patternFill patternType="gray125"/></fill>`
    + `<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>`
    + `</fills>`
    // 框線 0=無  1=四邊 medium（標頭）  2=左右 medium（資料）
    + `<borders count="3">`
    + `<border><left/><right/><top/><bottom/><diagonal/></border>`
    + `<border><left style="medium"><color indexed="64"/></left><right style="medium"><color indexed="64"/></right><top style="medium"><color indexed="64"/></top><bottom style="medium"><color indexed="64"/></bottom><diagonal/></border>`
    + `<border><left style="medium"><color indexed="64"/></left><right style="medium"><color indexed="64"/></right><top/><bottom/><diagonal/></border>`
    + `</borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment vertical="center"/></xf></cellStyleXfs>`
    // xf 0=預設  1=標頭（黃底紅粗字四邊框）  2=資料（Arial無底色左右框） 3=純文字（無框無底）
    + `<cellXfs count="4">`
    + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="center"/></xf>`
    + `<xf numFmtId="49" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>`
    + `<xf numFmtId="49" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>`
    + `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>`
    + `</cellXfs>`
    + `</styleSheet>`;
}

function sheetXml(headerLabel, cues, fps, dropFrame) {
  // 欄寬：A 欄（時碼）28，B 欄（字幕）60，套用 style="3" 強制設定為純文字格式
  const colDefs = `<cols><col min="1" max="1" width="28" customWidth="1" style="3"/><col min="2" max="2" width="60" customWidth="1" style="3"/><col min="3" max="16384" width="11" style="3"/></cols>`;
  const rows = [
    // 標頭列：黃底紅粗字四邊框（s="1"），列高 17.25
    `<row r="1" ht="17.25" customHeight="1">`
    + `<c r="A1" t="inlineStr" s="1"><is><t>${xmlEsc(headerLabel)}</t></is></c>`
    + `<c r="B1" t="inlineStr" s="1"><is><t>字幕</t></is></c>`
    + `</row>`
  ];
  for (let i = 0; i < cues.length; i++) {
    const r = i + 2;
    const c = cues[i];
    const inTc  = secToEncore(c.start, fps, dropFrame);
    const outTc = secToEncore(c.end,   fps, dropFrame);
    rows.push(
      // 資料列：Arial 無底色，左右框（s="2"）
      `<row r="${r}">`
      + `<c r="A${r}" t="inlineStr" s="2"><is><t>${xmlEsc(`${inTc} ${outTc}`)}</t></is></c>`
      + `<c r="B${r}" t="inlineStr" s="2"><is><t xml:space="preserve">${xmlEsc(c.text)}</t></is></c>`
      + `</row>`
    );
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + colDefs
    + `<sheetData>${rows.join('')}</sheetData>`
    + `</worksheet>`;
}

/* ---- 分頁名稱清理（Excel 限制：≤31 字、不含 \/?*:[] 、不能空白）---- */
function safeSheetName(raw) {
  let s = (raw || '軌道').replace(/[\\/\?\*:\[\]]/g, '_').replace(/^'|'$/g, '').trim().substring(0, 31);
  return s || '軌道';
}

/* ---- 對外介面 ---- */
// trackDataList: Array<{ name: string, cues: SubCue[] }>
function buildXLSX(trackDataList, fps, dropFrame) {
  // FPS 標籤
  let fpsLabel;
  if (Math.abs(fps - 23.976) < 0.01)      fpsLabel = '23.976';
  else if (Math.abs(fps - 29.97) < 0.01)  fpsLabel = dropFrame ? '29.97df' : '29.97';
  else                                      fpsLabel = String(Math.round(fps));
  const headerLabel = `TimeCode_${fpsLabel}-FPS`;

  // 分頁名稱去重
  const sheetNames = [];
  for (const t of trackDataList) {
    let name = safeSheetName(t.name);
    let final = name;
    let counter = 2;
    while (sheetNames.includes(final)) { final = name.substring(0, 28) + '_' + counter++; }
    sheetNames.push(final);
  }

  const files = [
    { name: '[Content_Types].xml',       data: utf8(contentTypesXml(sheetNames.length)) },
    { name: '_rels/.rels',               data: utf8(relsXml()) },
    { name: 'xl/workbook.xml',           data: utf8(workbookXml(sheetNames)) },
    { name: 'xl/_rels/workbook.xml.rels',data: utf8(workbookRelsXml(sheetNames.length)) },
    { name: 'xl/styles.xml',             data: utf8(stylesXml()) },
  ];
  trackDataList.forEach(({ cues }, i) => {
    files.push({ name: `xl/worksheets/sheet${i+1}.xml`, data: utf8(sheetXml(headerLabel, cues, fps, dropFrame)) });
  });

  return buildZip(files);
}

export { buildXLSX };

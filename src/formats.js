/* ==============================================================================
   SUB Tool — 字幕格式 解析 / 序列化（SRT / ASS / Encore / TXT / formats.js）
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
import { clamp } from './util.js';
import { secToSRT, secToASS, secToEncore, srtToSec, assToSec, encoreToSec, getExactFps } from './time.js';
import { ASS_PLAY_RES, effStyle, styleToAssStyleLine, cueAssTags, cueAssPos, assJoinLines, assJoinVertical, verticalAssCols, assAlignN, assEscapeText, subtitleBackgroundCssMetrics, STYLE_ONLY_KEYS, CUE_STYLE_KEYS, STYLE_DEFAULTS, uiFontNameFromAss } from './substyle.js';
function finiteBackgroundLayout(layout){
  if(!layout || typeof layout !== 'object') return null;
  const lineIndex = Number(layout.lineIndex);
  const height = Number(layout.height);
  const offsetY = Number(layout.offsetY);
  const textLines = Array.isArray(layout.textLines) ? layout.textLines.map(line => ({
    x: Number(line?.x),
    cy: Number(line?.cy),
    hAlign: Number(line?.hAlign),
  })) : null;
  if(!Number.isSafeInteger(lineIndex) || lineIndex < 0 ||
     !Number.isFinite(height) || height <= 0 ||
     !Number.isFinite(offsetY) || !textLines?.length ||
     textLines.some(line => !Number.isFinite(line.x) || !Number.isFinite(line.cy) ||
       ![4, 5, 6].includes(line.hAlign))) return null;
  return { lineIndex, height, offsetY, textLines };
}

function backgroundMiddleAlignment(st){
  return { left:4, center:5, right:6 }[st?.align] || 5;
}

const BACKGROUND_SHAPING_KEYS = new Set(['font','fontSize','bold','italic','letterSpacing']);

function backgroundShapingDiff(diff){
  if(!diff) return null;
  const filtered = Object.fromEntries(Object.entries(diff)
    .filter(([key]) => BACKGROUND_SHAPING_KEYS.has(key)));
  return Object.keys(filtered).length ? filtered : null;
}

class AssDocumentBuilder {
  constructor(fps, vww = 1000, vwh = 562) {
    this.fps = fps;
    this.vww = vww;
    this.vwh = vwh;
    this.styles = new Map();
    this.events = [];
  }

  addStyle(name, st) {
    if (!this.styles.has(name)) {
      this.styles.set(name, styleToAssStyleLine(name, st, this.vwh));
    }
    return name;
  }

  /* Chromium 只凍結「哪一行最寬」與整塊的垂直幾何；背景寬度由 libass
     以正式輸出字型重新排出。文字與底框因此共用同一套 shaping/font metrics，
     左／中／右錨點都不需要猜跨引擎的寬度補償值。 */
  _backgroundText(layout, st, head, rawLines, cueStyle) {
    const line = String(rawLines[Math.min(layout.lineIndex, rawLines.length - 1)] || '').trim();
    if(!line) return '';
    const x = Math.round((st.posX / 100) * this.vww);
    const y = Math.round((st.posY / 100) * this.vwh);
    const metrics = subtitleBackgroundCssMetrics(st, 1);
    const top = y + layout.offsetY;
    // 不以字型的 top metrics 定位：VSFilter/PotPlayer 與 libass 對 ascender 的
    // 解讀並不完全相同，top-aligned 的放大底框會因此向上偏。改用已凍結的
    // 整段字幕中心定位，讓上下外擴不依賴特定 ASS renderer 的字型頂界。
    const centerY = Math.round(top + layout.height / 2);
    // 背景的高度只用 y-border 擴張，不再縮放字形。不同 ASS renderer 對
    // fscy 後的字型 ascender/descender 取值不同；ybord 則直接表達「從
    // 單行文字盒往外擴到整段高度」，比較接近 CSS 的整塊 padding 語義。
    const yBorder = Math.max(metrics.padY, (layout.height - metrics.fontSize) / 2);
    const angle = Number(st.angle) || 0;
    const rotate = `${angle ? `\\org(${x},${y})` : ''}\\frz${-angle}`;
    const shadow = Number.isFinite(Number(st.shadow)) ? Math.max(0, Number(st.shadow)) : 0;
    const shadowTags = shadow > 0
      ? `\\shad${shadow}\\4c&H000000&\\4a&H26&`
      : '\\shad0';
    const tags = `{\\q2\\an${backgroundMiddleAlignment(st)}\\pos(${x},${centerY})${rotate}`+
      `\\1a&HFF&\\fscy100.00\\xbord${metrics.padX.toFixed(1)}`+
      `\\ybord${yBorder.toFixed(1)}${shadowTags}}`;
    return head + cueAssTags(backgroundShapingDiff(cueStyle), st) + tags + assEscapeText(line);
  }

  addCue(cue, track, layout) {
    const st = effStyle(cue, track);
    const hasOwnStyle = cue.style && STYLE_ONLY_KEYS.some(k => cue.style[k] != null);
    
    const styName = hasOwnStyle 
      ? this.addStyle(`Cue_${String(cue.id).replace(/[^A-Za-z0-9_]/g,'')}`, st)
      : (track ? `Track${cue.track||0}` : 'Default');

    const baseStyle = hasOwnStyle ? st : effStyle(null, track);
    let textStyleName = styName;

    if (layout) {
      textStyleName = this.addStyle(`${styName}_Text`, { ...baseStyle, bgBox: false, shadow: 0 });
    }

    const textDiff = layout && cue.style
      ? Object.fromEntries(Object.entries(cue.style).filter(([key]) =>
        !['shadow','bgBox','bgColor','bgAlpha'].includes(key)))
      : cue.style;
      
    const tags = cueAssTags(textDiff, layout ? { ...st, bgBox:false } : st);
    const head = `Dialogue: ${100-(cue.track||0)},${secToASS(cue.start, this.fps)},${secToASS(cue.end, this.fps)},${textStyleName},atg${(cue.track||0)+1},0,0,0,,`;

    if (st.vertical) {
      const text = verticalAssCols(st, cue.text || '', this.vww, this.vwh)
        .map(col => `${head}{\\an${col.an}\\pos(${col.x},${col.y})}${tags}${assJoinVertical(col.chars, st)}`)
        .join('\n');
      this.events.push({ type: 'text', text });
      return;
    }

    const anOv = (cue.style && (cue.style.align != null || cue.style.valign != null) && !hasOwnStyle)
      ? `{\\an${assAlignN(st)}}` : '';
    
    const lines = String(cue.text || '').replace(/\r/g, '').split('\n').map(assEscapeText);

    if (layout) {
      const backgroundHead = `Dialogue: ${100-(cue.track||0)},${secToASS(cue.start, this.fps)},${secToASS(cue.end, this.fps)},${styName},atg${(cue.track||0)+1},0,0,0,,`;
      const background = this._backgroundText(layout, st, backgroundHead,
        String(cue.text || '').replace(/\r/g, '').split('\n'), cue.style);
      if(background) this.events.push({ type: 'background', text: background });
      const x = Math.round((st.posX / 100) * this.vww);
      const y = Math.round((st.posY / 100) * this.vwh);
      const blockOrigin = st.angle ? `\\org(${x},${y})` : '';
      const text = layout.textLines.map((l, i) => {
        return `${head}{\\an${l.hAlign}\\pos(${l.x},${l.cy})${blockOrigin}}${tags}${lines[i]}`;
      }).join('\n');
      this.events.push({ type: 'text', text });
    } else {
      const text = head + anOv + cueAssPos(st, this.vww, this.vwh) + tags + assJoinLines(lines, st);
      this.events.push({ type: 'text', text });
    }
  }

  build(metadata) {
    let stylesBlock = '';
    for (const line of this.styles.values()) stylesBlock += line + '\n';

    const backgrounds = this.events.filter(e => e.type === 'background').map(e => e.text);
    const texts = this.events.filter(e => e.type === 'text').map(e => e.text);
    const body = [...backgrounds, ...texts].join('\n');

    return `[Script Info]
; Script generated by SUB Tool
; SUBTOOL-ASS-TIME:2
${metadata}ScriptType: v4.00+
WrapStyle: 2
Collisions: Normal
PlayResX: ${this.vww}
PlayResY: ${this.vwh}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${stylesBlock}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${body}
`;
  }
}

function decodeLegacyLineBreaks(value){
  const text=String(value??'');
  const decodeChunk=chunk=>chunk.replace(/\\\\|\/\//g,'\n');
  // CJK 字幕常把網址直接接在全形標點後繼續寫；這些標點是 token 邊界，
  // 否則其後真正代表換行的 `//` 也會被整段誤保護。
  const uri=/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'，。！？；：、（）【】「」『』《》〈〉\(\)\[\]\{\}]*/g;
  let out='',last=0,match;
  while((match=uri.exec(text))){
    out+=decodeChunk(text.slice(last,match.index));
    out+=match[0];
    last=match.index+match[0].length;
  }
  return out+decodeChunk(text.slice(last));
}

/* ASS Dialogue 文字不能用 `{...}` regex 處理：`\{`／`\}` 是使用者的字面括號，
   assEscapeText 也會以零寬空格切斷字面 `\N`、`\n`、`\h`。逐字掃描才能同時
   移除真正的 override tag、解控制碼，並把我們自己的跳脫還原。 */
function decodeAssDialogueText(value){
  const text=String(value??'');
  let out='';
  for(let i=0;i<text.length;){
    const ch=text[i];
    if(ch==='\\'){
      const next=text[i+1];
      if(next==='{'||next==='}'){ out+=next; i+=2; continue; }
      if(next==='\u200b'&&/[Nnh]/.test(text[i+2]||'')){
        out+='\\'+text[i+2]; i+=3; continue;
      }
      if(next==='N'||next==='n'){ out+='\n'; i+=2; continue; }
      if(next==='h'){ out+=' '; i+=2; continue; }
      out+='\\'; i++; continue;
    }
    if(ch==='{'){
      let end=i+1;
      while(end<text.length){
        if(text[end]==='\\'){ end+=2; continue; }
        if(text[end]==='}') break;
        end++;
      }
      if(end<text.length){ i=end+1; continue; }
    }
    out+=ch;
    i++;
  }
  return decodeLegacyLineBreaks(out);
}

/* SUB Tool 自家 ASS 的無損補充資料。標準 ASS 僅能存百分秒與有限樣式欄位，
   因此用 [Script Info] 裡的 `;` 註解附帶 UTF-8/Base64 JSON；任何一般 ASS 播放器
   都會忽略它。必須顯式 includeMetadata，避免 mpv 即時預覽／燒錄用 ASS 反覆夾帶整份專案。 */
const SUBTOOL_META_VERSION = 1;
const SUBTOOL_META_CHUNK_SIZE = 768;
const MAX_SUBTOOL_META_CHUNKS = 16384;
const MAX_SUBTOOL_META_BYTES = 8 * 1024 * 1024;
const MAX_SUBTOOL_META_TRACKS = 1000;
const MAX_SUBTOOL_META_CUES = 100000;
const MAX_SUBTOOL_META_TEXT = 100000;
const MAX_SUBTOOL_META_SECONDS = 1000000000;
const MAX_SUBTOOL_META_FRAME = 1000000000000;
const TRACK_META_KEYS = new Set(['name', 'visible', 'locked', 'posPct', ...Object.keys(STYLE_DEFAULTS)]);
const CUE_META_KEYS = new Set(['id', 'startFrame', 'endFrame', 'start', 'end', 'text', 'track', 'timed', 'style']);
const META_STYLE_BOOL_KEYS = new Set(['bold', 'italic', 'vertical', 'bgBox']);
const META_STYLE_COLOR_KEYS = new Set(['color', 'outlineColor', 'bgColor']);
const META_STYLE_NUMBER_LIMITS = {
  fontSize: [10, 300], letterSpacing: [0, 30], lineSpacing: [1, 3], outline: [0, 10], shadow: [0, 10],
  bgAlpha: [0, 1], posX: [0, 100], posY: [0, 100], angle: [-180, 180],
};

function hasOwn(obj, key){ return Object.prototype.hasOwnProperty.call(obj, key); }
function isPlainRecord(value){
  if(!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype || proto===null;
}
function boundedNumber(value, min, max){
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}
function safeLabel(value){
  return typeof value === 'string' && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}
function safeFont(value){
  const label=safeLabel(value);
  // metadata 會以 Base64 JSON 存放，預覽 CSS 也把字型名置於單引號內；逗號與分號都
  // 是安全的字面字元，不能讓自產 ASS 因 `Family, Variant` 靜默失去 metadata。引號／
  // 反斜線才會突破 CSS 字串；標準 ASS Style 的逗號限制則由其序列化層另行處理。
  return label != null && !/['"{}\\]/.test(label) ? label : null;
}
function safeCueText(value){
  return typeof value === 'string' && value.length <= MAX_SUBTOOL_META_TEXT && !/[\u0000\u007f]/.test(value) ? value : null;
}
function normalizeStyleValue(key, value){
  if(META_STYLE_BOOL_KEYS.has(key)) return typeof value === 'boolean' ? value : null;
  if(META_STYLE_COLOR_KEYS.has(key)) return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
  if(key === 'font') return safeFont(value);
  if(key === 'align') return ['left', 'center', 'right'].includes(value) ? value : null;
  if(key === 'valign') return ['top', 'middle', 'bottom'].includes(value) ? value : null;
  const limits=META_STYLE_NUMBER_LIMITS[key];
  return limits ? boundedNumber(value, limits[0], limits[1]) : null;
}
function normalizeStyleRecord(value, strict=false){
  if(!isPlainRecord(value)) return strict ? null : {};
  const out={};
  for(const [key, raw] of Object.entries(value)){
    if(!CUE_STYLE_KEYS.includes(key)){
      if(strict) return null;
      continue;
    }
    const clean=normalizeStyleValue(key, raw);
    if(clean == null){
      if(strict) return null;
      continue;
    }
    out[key]=clean;
  }
  return out;
}
function normalizeTrackRecord(value, strict=false){
  if(!isPlainRecord(value)) return strict ? null : {};
  const out={};
  for(const [key, raw] of Object.entries(value)){
    if(!TRACK_META_KEYS.has(key)){
      if(strict) return null;
      continue;
    }
    let clean=null;
    if(key === 'name') clean=safeLabel(raw);
    else if(key === 'visible' || key === 'locked') clean=typeof raw === 'boolean' ? raw : null;
    else if(key === 'posPct') clean=boundedNumber(raw, 0, 100);
    else clean=normalizeStyleValue(key, raw);
    if(clean == null){
      if(strict) return null;
      continue;
    }
    out[key]=clean;
  }
  return out;
}
function metadataTrackIndex(value){
  return Number.isSafeInteger(value) && value >= 0 && value < MAX_SUBTOOL_META_TRACKS ? value : null;
}
function metadataSeconds(value){
  const sec=Number(value);
  return Number.isFinite(sec) && sec >= 0 && sec <= MAX_SUBTOOL_META_SECONDS ? sec : 0;
}
function metadataFrame(value, exactFps){
  const frame=Math.round(metadataSeconds(value) * exactFps);
  return Math.max(0, Math.min(MAX_SUBTOOL_META_FRAME, frame));
}
function metadataCue(value, exactFps){
  if(!isPlainRecord(value)) return null;
  const cue=value;
  const start=boundedNumber(Number(cue.start), 0, MAX_SUBTOOL_META_SECONDS);
  const end=boundedNumber(Number(cue.end), 0, MAX_SUBTOOL_META_SECONDS);
  const text=safeCueText(cue.text);
  const track=cue.track == null ? 0 : metadataTrackIndex(cue.track);
  if(start == null || end == null || end < start || text == null || track == null) return null;
  const out={
    startFrame: metadataFrame(start, exactFps), endFrame: metadataFrame(end, exactFps), start, end,
    text, track, timed: cue.timed !== false,
  };
  if((typeof cue.id === 'string' && safeLabel(cue.id) != null) || (typeof cue.id === 'number' && Number.isSafeInteger(cue.id))) out.id=cue.id;
  if(cue.style != null){
    const style=normalizeStyleRecord(cue.style, true);
    if(style == null) return null;
    if(Object.keys(style).length) out.style=style;
  }
  return out;
}
function buildSubtoolMetadata(cues, fps, tracks, options){
  const safeFps=boundedNumber(Number(fps), 1, 240);
  const sourceCues=Array.isArray(cues) ? cues : [];
  const sourceTracks=Array.isArray(tracks) ? tracks : [];
  if(safeFps == null || sourceCues.length > MAX_SUBTOOL_META_CUES || sourceTracks.length > MAX_SUBTOOL_META_TRACKS) return null;
  const exactFps=getExactFps(safeFps);
  const safeCues=sourceCues.map(cue=>metadataCue(cue, exactFps));
  if(safeCues.some(cue=>cue == null)) return null;
  const trackCount=Math.max(sourceTracks.length, ...safeCues.map(cue=>cue.track + 1), 0);
  if(trackCount > MAX_SUBTOOL_META_TRACKS) return null;
  // 不認識的舊欄位可以略過；但已知、可表示的樣式欄位若不安全/無效，不能靜默
  // 漏掉後還宣稱「無損」。這種情況寧可不寫 metadata，讓標準 ASS fallback 接手。
  const safeTracks=Array.from({length:trackCount}, (_, index)=>{
    const source=sourceTracks[index];
    const normalized=normalizeTrackRecord(source);
    if(isPlainRecord(source)){
      for(const key of TRACK_META_KEYS){
        if(source[key] != null && !hasOwn(normalized, key)) return null;
      }
    }
    return normalized;
  });
  if(safeTracks.some(track=>track == null)) return null;
  return {
    version: SUBTOOL_META_VERSION, fps: safeFps, dropFrame: !!(options && options.dropFrame),
    tracks: safeTracks, cues: safeCues,
  };
}
function utf8ToBase64(value){
  const bytes=new TextEncoder().encode(value);
  let binary='';
  for(let i=0;i<bytes.length;i+=0x8000) binary+=String.fromCharCode(...bytes.subarray(i, i+0x8000));
  return btoa(binary);
}
function base64ToUtf8(value){
  const binary=atob(value);
  if(binary.length > MAX_SUBTOOL_META_BYTES) throw new Error('metadata too large');
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return new TextDecoder('utf-8', {fatal:true}).decode(bytes);
}
function encodeSubtoolMetadata(metadata){
  try{
    const data=utf8ToBase64(JSON.stringify(metadata));
    if(data.length > Math.ceil(MAX_SUBTOOL_META_BYTES / 3) * 4) return '';
    const count=Math.ceil(data.length / SUBTOOL_META_CHUNK_SIZE);
    if(!count || count > MAX_SUBTOOL_META_CHUNKS) return '';
    const lines=[];
    for(let index=0;index<count;index++) lines.push(`; SUBTOOL-META:${SUBTOOL_META_VERSION}:${index+1}/${count}:${data.slice(index*SUBTOOL_META_CHUNK_SIZE, (index+1)*SUBTOOL_META_CHUNK_SIZE)}`);
    return lines.join('\n')+'\n';
  }catch(e){ return ''; }
}
function validateMetadataCue(value, trackCount){
  if(!isPlainRecord(value) || Object.keys(value).some(key=>!CUE_META_KEYS.has(key))) return null;
  const required=['startFrame', 'endFrame', 'start', 'end', 'text', 'track', 'timed'];
  if(required.some(key=>!hasOwn(value, key))) return null;
  const startFrame=Number.isSafeInteger(value.startFrame) && value.startFrame >= 0 && value.startFrame <= MAX_SUBTOOL_META_FRAME ? value.startFrame : null;
  const endFrame=Number.isSafeInteger(value.endFrame) && value.endFrame >= startFrame && value.endFrame <= MAX_SUBTOOL_META_FRAME ? value.endFrame : null;
  const start=boundedNumber(value.start, 0, MAX_SUBTOOL_META_SECONDS);
  const end=boundedNumber(value.end, start == null ? 0 : start, MAX_SUBTOOL_META_SECONDS);
  const text=safeCueText(value.text);
  const track=Number.isSafeInteger(value.track) && value.track >= 0 && value.track < trackCount ? value.track : null;
  if(startFrame == null || endFrame == null || start == null || end == null || text == null || track == null || typeof value.timed !== 'boolean') return null;
  const out={startFrame, endFrame, start, end, text, track, timed:value.timed};
  if(hasOwn(value, 'id')){
    if(!((typeof value.id === 'string' && safeLabel(value.id) != null) || (typeof value.id === 'number' && Number.isSafeInteger(value.id)))) return null;
    out.id=value.id;
  }
  if(hasOwn(value, 'style')){
    const style=normalizeStyleRecord(value.style, true);
    if(style == null) return null;
    out.style=style;
  }
  return out;
}
function validateSubtoolMetadata(value){
  const keys=new Set(['version', 'fps', 'dropFrame', 'tracks', 'cues']);
  if(!isPlainRecord(value) || Object.keys(value).some(key=>!keys.has(key))) return null;
  if(value.version !== SUBTOOL_META_VERSION || !hasOwn(value, 'fps') || !hasOwn(value, 'dropFrame') || !Array.isArray(value.tracks) || !Array.isArray(value.cues)) return null;
  const fps=boundedNumber(value.fps, 1, 240);
  if(fps == null || typeof value.dropFrame !== 'boolean' || value.tracks.length > MAX_SUBTOOL_META_TRACKS || value.cues.length > MAX_SUBTOOL_META_CUES) return null;
  const tracks=[];
  for(const track of value.tracks){
    const clean=normalizeTrackRecord(track, true);
    if(clean == null) return null;
    tracks.push(clean);
  }
  const cues=[];
  for(const cue of value.cues){
    const clean=validateMetadataCue(cue, tracks.length);
    if(clean == null) return null;
    cues.push(clean);
  }
  return {version:SUBTOOL_META_VERSION, fps, dropFrame:value.dropFrame, tracks, cues};
}
function decodeSubtoolMetadata(lines){
  const chunks=[];
  let sawMetadata=false;
  for(const line of lines){
    if(!/^\s*;\s*SUBTOOL-META:/i.test(line)) continue;
    sawMetadata=true;
    const match=line.match(/^\s*;\s*SUBTOOL-META:(\d+):(\d+)\/(\d+):([A-Za-z0-9+/=]+)\s*$/i);
    if(!match) return null;
    const version=Number(match[1]), index=Number(match[2]), total=Number(match[3]);
    if(version !== SUBTOOL_META_VERSION || !Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || index > total || total > MAX_SUBTOOL_META_CHUNKS) return null;
    chunks.push({index, total, data:match[4]});
  }
  if(!sawMetadata) return null;
  if(!chunks.length || chunks.some(chunk=>chunk.total !== chunks[0].total) || chunks.length !== chunks[0].total) return null;
  const ordered=Array(chunks[0].total);
  for(const chunk of chunks){ if(ordered[chunk.index-1] != null) return null; ordered[chunk.index-1]=chunk.data; }
  if(ordered.some(chunk=>typeof chunk !== 'string')) return null;
  const base64=ordered.join('');
  if(base64.length > Math.ceil(MAX_SUBTOOL_META_BYTES / 3) * 4 || base64.length % 4) return null;
  try{ return validateSubtoolMetadata(JSON.parse(base64ToUtf8(base64))); }catch(e){ return null; }
}

/* ---- 外部 ASS 樣式（best effort） ---------------------------------------
   SUB Tool 的每一句只有一組完整樣式，無法表示 ASS 的字內局部變色、\t 動畫、\move
   或 karaoke。因此只採用 Style 行與「文字前」靜態 override；這是一般剪輯軟體輸出的
   常見形式，也避免把文字中途才開始的樣式錯套到整句前半。所有值都先限縮到本工具的
   可表示範圍，尤其 font 會進 CSS 的單引號字串，不能直接信任外部檔案。 */
const ASS_DEFAULT_STYLE_FIELDS=['name','fontname','fontsize','primarycolour','secondarycolour','outlinecolour','backcolour','bold','italic','underline','strikeout','scalex','scaley','spacing','angle','borderstyle','outline','shadow','alignment','marginl','marginr','marginv','encoding'];
const ASS_DEFAULT_EVENT_FIELDS=['layer','start','end','style','name','marginl','marginr','marginv','effect','text'];

function assFields(line){
  return line.replace(/^Format:\s*/i,'').split(',').map(field=>field.trim().toLowerCase());
}
function assRecord(rest, fields){
  const parts=splitN(rest, fields.length-1), out=Object.create(null);
  fields.forEach((field,index)=>{ out[field]=parts[index]!==undefined ? parts[index].trim() : ''; });
  return out;
}
function assFinite(value, min, max){
  const raw=String(value??'').trim();
  if(!raw) return null;
  const number=Number(raw);
  return Number.isFinite(number) && number>=min && number<=max ? number : null;
}
function assToggle(value){
  const number=assFinite(value,-100000,100000);
  return number == null ? null : number!==0;
}
function assScaled(value, scale, min, max){
  const number=assFinite(value, -100000, 100000);
  return number == null ? null : clamp(number*scale, min, max);
}
function assColour(value){
  let raw=String(value??'').trim();
  if(/^&H[0-9a-f]+&?$/i.test(raw)) raw=raw.replace(/^&H/i,'').replace(/&$/,'');
  else if(/^-?\d+$/.test(raw)){
    const decimal=Number(raw);
    if(!Number.isSafeInteger(decimal)) return null;
    raw=(decimal>>>0).toString(16).padStart(8,'0');
  }else return null;
  if(!/^[0-9a-f]{1,8}$/i.test(raw)) return null;
  const bgr=raw.padStart(6,'0').slice(-6).toLowerCase();
  const alpha=raw.length>6 ? parseInt(raw.slice(-8,-6),16) : 0;
  return { color:`#${bgr.slice(4,6)}${bgr.slice(2,4)}${bgr.slice(0,2)}`, alpha:alpha/255 };
}
function assAlpha(value){
  const raw=String(value??'').trim().replace(/^&H/i,'').replace(/&$/,'');
  return /^[0-9a-f]{1,2}$/i.test(raw) ? parseInt(raw,16)/255 : null;
}
function assAlignment(value){
  const n=Math.round(Number(value));
  const horizontal={1:'left',2:'center',3:'right',4:'left',5:'center',6:'right',7:'left',8:'center',9:'right'}[n];
  const vertical={1:'bottom',2:'bottom',3:'bottom',4:'middle',5:'middle',6:'middle',7:'top',8:'top',9:'top'}[n];
  return horizontal && vertical ? {align:horizontal,valign:vertical} : null;
}
function assAngle(value){
  const n=assFinite(value, -100000, 100000);
  if(n == null) return null;
  // ASS 的正角度與 CSS / SUB Tool 相反；超過一圈取等效角，仍維持 UI 可編輯範圍。
  const reversed=-n;
  return ((reversed+180)%360+360)%360-180;
}
function assPlayRes(info){
  const x=assFinite(info.playresx, 1, 100000) || ASS_PLAY_RES.x;
  const y=assFinite(info.playresy, 1, 100000) || ASS_PLAY_RES.y;
  return {x,y,scaleY:ASS_PLAY_RES.y/y};
}
function assApplyMargins(style, record, res, preferRecord=false){
  const margin=key=>{
    const own=assFinite(record[key], 0, 100000);
    // Event 的 0 是「沿用 Style」，Style 行本身的 0 則是合法的邊界位置。
    return preferRecord ? (own != null && own > 0 ? own : null) : own;
  };
  const marginL=margin('marginl'), marginR=margin('marginr'), marginV=margin('marginv');
  if(style.align==='left' && marginL != null) style.posX=clamp(marginL/res.x*100,0,100);
  else if(style.align==='right' && marginR != null) style.posX=clamp(100-marginR/res.x*100,0,100);
  if(style.valign==='top' && marginV != null) style.posY=clamp(marginV/res.y*100,0,100);
  else if(style.valign==='bottom' && marginV != null) style.posY=clamp(100-marginV/res.y*100,0,100);
}
function assResetMarginAnchors(style){
  // ASS Style 沒有自由座標；沒有 \pos 時，每次 Alignment 改變都必須從它的錨點重算，
  // 不可沿用前一個 left/right/top/bottom 解析結果，否則 \an2 仍會留在舊左邊界。
  style.posX=style.align==='left' ? 0 : style.align==='right' ? 100 : 50;
  style.posY=style.valign==='top' ? 0 : style.valign==='bottom' ? 100 : 50;
}
function assStyleFromRecord(record, res){
  const style={...STYLE_DEFAULTS};
  const font=safeFont(uiFontNameFromAss(record.fontname)); if(font != null) style.font=font;
  const fontSize=assScaled(record.fontsize,res.scaleY,10,300); if(fontSize != null) style.fontSize=fontSize;
  const primary=assColour(record.primarycolour); if(primary) style.color=primary.color;
  const outline=assColour(record.outlinecolour || record.tertiarycolour); if(outline) style.outlineColor=outline.color;
  const back=assColour(record.backcolour); if(back){ style.bgColor=back.color; style.bgAlpha=clamp(1-back.alpha,0,1); }
  const bold=assToggle(record.bold); if(bold != null) style.bold=bold;
  const italic=assToggle(record.italic); if(italic != null) style.italic=italic;
  const spacing=assScaled(record.spacing,res.scaleY,0,30); if(spacing != null) style.letterSpacing=spacing;
  const outlineWidth=assScaled(record.outline,res.scaleY,0,10); if(outlineWidth != null) style.outline=outlineWidth;
  const shadow=assScaled(record.shadow,res.scaleY,0,10); if(shadow != null) style.shadow=shadow;
  const angle=assAngle(record.angle); if(angle != null) style.angle=angle;
  const alignment=assAlignment(record.alignment); if(alignment) Object.assign(style,alignment);
  const borderStyle=assFinite(record.borderstyle,1,3); if(borderStyle != null) style.bgBox=borderStyle===3;
  assResetMarginAnchors(style);
  assApplyMargins(style,record,res);
  return style;
}
function assLeadingOverrideBlocks(value){
  const text=String(value??''); let at=0; const blocks=[];
  while(text[at]==='{'){
    let end=at+1;
    while(end<text.length){
      if(text[end]==='\\'){ end+=2; continue; }
      if(text[end]==='}') break;
      end++;
    }
    if(end>=text.length) break;
    blocks.push(text.slice(at+1,end)); at=end+1;
  }
  return blocks;
}
function assWithoutTransforms(value){
  let out='', at=0;
  while(at<value.length){
    if(value[at]==='\\' && value[at+1]?.toLowerCase()==='t' && value[at+2]==='('){
      let depth=1, end=at+3;
      while(end<value.length && depth){ if(value[end]==='(') depth++; else if(value[end]===')') depth--; end++; }
      if(!depth){ at=end; continue; }
    }
    out+=value[at++];
  }
  return out;
}
function assApplyLeadingOverrides(baseStyle, baseMargins, text, styles, styleMargins, res){
  let style={...baseStyle}, margins=baseMargins, explicitPosition=false;
  for(const block of assLeadingOverrideBlocks(text)){
    const tags=assWithoutTransforms(block);
    const matcher=/\\(fsp|fn|fs|3c|4c|4a|1c|c|bord|shad|frz|an|pos|r|b|i)(?:\(([^)]*)\)|([^\\{}]*))/gi;
    let match;
    while((match=matcher.exec(tags))){
      const tag=match[1].toLowerCase(), raw=(match[2]!==undefined ? match[2] : match[3]).trim();
      if(tag==='r'){
        const resetKey=raw.toLowerCase(), reset=raw ? styles.get(resetKey) : baseStyle;
        style={...(reset || baseStyle)};
        margins=raw ? (styleMargins.get(resetKey)||baseMargins) : baseMargins;
      }else if(tag==='fn'){
        const font=safeFont(uiFontNameFromAss(raw)); if(font != null) style.font=font;
      }else if(tag==='fs'){
        const relative=/^[+-]/.test(raw), sourceSize=assFinite(raw,-100000,100000);
        if(sourceSize != null){
          const size=sourceSize*res.scaleY;
          if(relative) style.fontSize=clamp(style.fontSize+size,10,300);
          else if(size>0) style.fontSize=clamp(size,10,300);
        }
      }else if(tag==='fsp'){
        const spacing=assScaled(raw,res.scaleY,0,30); if(spacing != null) style.letterSpacing=spacing;
      }else if(tag==='bord'){
        const outline=assScaled(raw,res.scaleY,0,10); if(outline != null) style.outline=outline;
      }else if(tag==='shad'){
        const shadow=assScaled(raw,res.scaleY,0,10); if(shadow != null) style.shadow=shadow;
      }else if(tag==='b' || tag==='i'){
        const enabled=assToggle(raw); if(enabled != null) style[tag==='b'?'bold':'italic']=enabled;
      }else if(tag==='frz'){
        const angle=assAngle(raw); if(angle != null) style.angle=angle;
      }else if(tag==='an'){
        const alignment=assAlignment(raw); if(alignment) Object.assign(style,alignment);
      }else if(tag==='pos'){
        const [x,y]=raw.split(',').map(part=>assFinite(part,-100000,100000));
        if(x != null && y != null){ style.posX=clamp(x/res.x*100,0,100); style.posY=clamp(y/res.y*100,0,100); explicitPosition=true; }
      }else if(tag==='c' || tag==='1c' || tag==='3c' || tag==='4c'){
        const colour=assColour(raw);
        if(colour){
          if(tag==='3c') style.outlineColor=colour.color;
          else if(tag==='4c') style.bgColor=colour.color;
          else style.color=colour.color;
        }
      }else if(tag==='4a'){
        const alpha=assAlpha(raw); if(alpha != null) style.bgAlpha=clamp(1-alpha,0,1);
      }
    }
  }
  return {style,margins,explicitPosition};
}

/* ===== 2. 字幕格式 解析 / 序列化 ====================================== */
const SubFormats = {
  /* ---- SRT ---- */
  parseSRT(text){
    const out=[]; const blocks=text.replace(/\r/g,'').split(/\n{2,}/);
    for(const blk of blocks){
      const lines=blk.split('\n');
      let i=0; while(i<lines.length && /^\s*\d+\s*$/.test(lines[i]))i++;
      const tline=lines[i]; if(!tline||!tline.includes('-->'))continue;
      const [a,b]=tline.split('-->');
      const start=srtToSec(a), end=srtToSec(b);
      const txt=decodeLegacyLineBreaks(lines.slice(i+1).join('\n')).trim();
      out.push({start,end,text:txt});
    }
    return out;
  },
  toSRT(cues){
    return cues.filter(c=>c.timed!==false).map((c,i)=>
      `${i+1}\n${secToSRT(c.start)} --> ${secToSRT(c.end)}\n${c.text||''}`).join('\n\n').replace(/\r?\n/g, '\r\n')+'\r\n\r\n';
  },
  /* ---- ASS ---- */
  parseASS(text){
    const out=[]; const lines=text.replace(/\r/g,'').split('\n');
    const subtool=decodeSubtoolMetadata(lines);
    const scriptInfo=Object.create(null), rawStyles=[], rawEvents=[];
    let section='', styleFormat=null, eventFormat=null;
    for(const ln of lines){
      const t=ln.trim();
      const sectionMatch=t.match(/^\[([^\]]+)]$/);
      if(sectionMatch){ section=sectionMatch[1].trim().toLowerCase(); continue; }
      if(section==='script info'){
        const info=t.match(/^([^:;][^:]*):\s*(.*)$/);
        if(info) scriptInfo[info[1].trim().toLowerCase()]=info[2].trim();
      }
      if(/^Format:/i.test(t)){
        const fields=assFields(t);
        if(section==='v4+ styles' || section==='v4 styles') styleFormat=fields;
        else if(section==='events' || (fields.includes('start') && fields.includes('text'))) eventFormat=fields;
        continue;
      }
      if(/^Style:/i.test(t) && (section==='v4+ styles' || section==='v4 styles')){
        rawStyles.push(assRecord(t.replace(/^Style:\s*/i,''),styleFormat||ASS_DEFAULT_STYLE_FIELDS));
        continue;
      }
      if(/^Dialogue:/i.test(t)){
        const rest=t.replace(/^Dialogue:\s*/i,'');
        rawEvents.push(assRecord(rest,eventFormat||ASS_DEFAULT_EVENT_FIELDS));
      }
    }
    const res=assPlayRes(scriptInfo), styles=new Map(), styleMargins=new Map();
    for(const record of rawStyles){
      const name=String(record.name||'').trim();
      if(name && safeLabel(name) != null){
        const key=name.toLowerCase();
        styles.set(key,assStyleFromRecord(record,res));
        styleMargins.set(key,record);
      }
    }
    for(const rec of rawEvents){
      const txt=decodeAssDialogueText(rec.text||'').trim();
      let track=0;
      const nm=(rec.name||'').match(/atg?(\d+)/i); if(nm)track=Math.max(0,+nm[1]-1);
      else if(/^\d+$/.test(rec.layer))track=clamp(+rec.layer,0,9);
      const styleName=String(rec.style||'').trim().toLowerCase();
      const sourceStyle=styles.get(styleName);
      const sourceMargins=styleMargins.get(styleName);
      const hasOverrides=assLeadingOverrideBlocks(rec.text).length>0;
      const cue={start:assToSec(rec.start),end:assToSec(rec.end),text:txt,track};
      if(sourceStyle || hasOverrides){
        const withMargins={...(sourceStyle||STYLE_DEFAULTS)};
        if(sourceMargins) assApplyMargins(withMargins,sourceMargins,res);
        assApplyMargins(withMargins,rec,res,true);
        const applied=assApplyLeadingOverrides(withMargins,sourceMargins,rec.text,styles,styleMargins,res);
        // \an 的位置語意由最終 alignment 決定；若沒有明確 \pos，必須在 override
        // 後以「Dialogue 非零 margin 優先、否則 Style margin」重算一次。
        if(!applied.explicitPosition){
          assResetMarginAnchors(applied.style);
          if(applied.margins) assApplyMargins(applied.style,applied.margins,res);
          assApplyMargins(applied.style,rec,res,true);
        }
        cue.style=applied.style;
      }
      out.push(cue);
    }
    // Array 仍是既有公開介面；metadata 故意做成非列舉屬性，舊的 map/filter/序列化程式
    // 不會把它當成一條字幕。呼叫端只有在存在且已通過完整驗證時才可採用它。
    if(subtool) Object.defineProperty(out, 'subtool', {value:subtool, enumerable:false});
    // v5.4.14 前的自產 ASS 以「先減半格」寫百分秒，29.97 回匯時會穩定落到前一格。
    // 新版一律寫 timing marker；只有舊 header 且沒有 marker/metadata 的檔案才交給匯入
    // 規劃層依使用者確認的 FPS 反推原格，不能誤修一般外部 ASS。
    const legacyHeader=lines.some(line=>/^\s*;\s*Script generated by SUB Tool\s*$/i.test(line));
    const timingMarker=lines.some(line=>/^\s*;\s*SUBTOOL-ASS-TIME:2\s*$/i.test(line));
    if(!subtool && legacyHeader && !timingMarker) Object.defineProperty(out, 'subtoolLegacy', {value:true, enumerable:false});
    return out;
  },
  toASS(cues,fps,tracks=[], vww=1000, vwh=562, options={}){
    const backgroundLayouts = options?.backgroundLayouts && typeof options.backgroundLayouts === 'object'
      ? options.backgroundLayouts : {};
    const metadataPayload=options && options.includeMetadata === true
      ? buildSubtoolMetadata(cues, fps, tracks, options) : null;
    const metadata=metadataPayload ? encodeSubtoolMetadata(metadataPayload) : '';

    const builder = new AssDocumentBuilder(fps, vww, vwh);

    if (!tracks || !tracks.length) {
      builder.addStyle('Default', effStyle(null, null));
    } else {
      tracks.forEach((tk, i) => { builder.addStyle(`Track${i}`, effStyle(null, tk)); });
      builder.addStyle('Default', effStyle(null, null));
    }

    const vis = cues.filter(c => {
      if(c.timed === false) return false;
      const tk = c.track || 0;
      if(tracks && tracks[tk] && tracks[tk].visible === false) return false;
      return true;
    });

    const trkOf = c => (tracks && tracks.length > (c.track||0)) ? tracks[c.track||0] : null;

    for (const c of vis) {
      const trk = trkOf(c);
      const st = effStyle(c, trk);
      const layout = st.bgBox && !st.vertical
        ? finiteBackgroundLayout(backgroundLayouts[String(c.id)]) : null;
      
      builder.addCue(c, trk, layout);
    }

    return builder.build(metadata);
  },
  /* ---- Adobe Encore ---- */
  parseEncore(text,fps,df=false){
    const out=[]; const lines=text.replace(/\r/g,'').split('\n');
    const re=/^\s*(\d{1,2}:\d{2}:\d{2}[:;]\d{2}|--:--:--:--)\s+(\d{1,2}:\d{2}:\d{2}[:;]\d{2}|--:--:--:--)\s+(.*)$/;
    let lastTime = 0;
    for(const ln of lines){
      const m=ln.match(re); if(!m)continue;
      const isUntimed = m[1]==='--:--:--:--' || m[2]==='--:--:--:--';
      let start = 0, end = 0;
      if(!isUntimed){
        start = encoreToSec(m[1],fps,df);
        end = encoreToSec(m[2],fps,df);
        lastTime = end;
      } else {
        start = lastTime;
        end = lastTime;
      }
      out.push({
        start, end,
        text: decodeLegacyLineBreaks(m[3].replace(/\s{2,}/g,'\n')).trim(),
        timed: isUntimed ? false : undefined
      });
    }
    return out;
  },
  toEncore(cues,fps,df=false){
    return cues.map(c=>{
      if(c.timed===false) return `--:--:--:-- --:--:--:-- ${(c.text||'').replace(/\n/g,'\\\\')}`;
      return `${secToEncore(c.start,fps,df)} ${secToEncore(c.end,fps,df)} ${(c.text||'').replace(/\n/g,'\\\\')}`;
    }).join('\r\n')+'\r\n';
  },
  /* ---- 純文字 ---- */
  parseTXT(text){
    let t = 0;
    return text.replace(/\r/g,'').split('\n').map(l=>l.trim()).filter(l=>l.length)
      .map(l=>{ const c={start:t,end:t,text:decodeLegacyLineBreaks(l),timed:false}; t+=0.001; return c; });
  },
  toTXT(cues){
    return cues.map(c=>(c.text||'').replace(/\n/g, '\\\\')).join('\n')+'\n';
  }
};
/* 把字串以逗號切成 n 段，第 n 段含其餘全部 */
function splitN(str,n){
  const out=[]; let i=0;
  for(let k=0;k<n;k++){ const j=str.indexOf(',',i); if(j<0){out.push(str.slice(i));return out;} out.push(str.slice(i,j)); i=j+1; }
  out.push(str.slice(i)); return out;
}

export function renderASS(cues, { fps, tracks = [], dropFrame = false, ...options } = {}) {
  const { x: RX, y: RY } = ASS_PLAY_RES;
  return SubFormats.toASS(Array.isArray(cues) ? cues : [], fps, tracks, RX, RY, {
    ...options,
    dropFrame,
  });
}

export { SubFormats, splitN, decodeLegacyLineBreaks, decodeAssDialogueText };

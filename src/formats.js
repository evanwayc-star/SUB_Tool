/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/formats.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
/* SUB Tool — 字幕格式 解析 / 序列化（SRT / ASS / Encore / TXT） */
import { clamp } from './util.js';
import { secToSRT, secToASS, secToEncore, srtToSec, assToSec, encoreToSec, getExactFps } from './time.js';
import { ASS_PLAY_RES, effStyle, styleToAssStyleLine, cueAssTags, cueAssPos, assJoinLines, assJoinVertical, verticalAssCols, assAlignN, assEscapeText, subtitleBackgroundCssMetrics, STYLE_ONLY_KEYS, CUE_STYLE_KEYS, STYLE_DEFAULTS, uiFontNameFromAss } from './substyle.js';

function finiteBackgroundLayout(layout){
  if(!layout || typeof layout !== 'object') return null;
  const lineIndex = Number(layout.lineIndex), height = Number(layout.height);
  const offsetY = Number(layout.offsetY);
  if(!Number.isSafeInteger(lineIndex) || lineIndex < 0 ||
     ![height, offsetY].every(Number.isFinite) || height <= 0) return null;
  return { lineIndex, height, offsetY };
}

function backgroundTopAlignment(st){
  return { left:7, center:8, right:9 }[st?.align] || 8;
}

/* Chromium 只選出「哪一行最寬」與整塊的垂直幾何；實際寬度必須交給
   同一個 libass/font provider 排版，不能把瀏覽器的字寬數字當成 ASS 字寬。
   BorderStyle=3 的垂直縮放在 libass 會同時作用於字級與字形座標，實測高度
   近似 fontSize * scale^2；依 frozen DOM 高度反解 scale，可用單一原生盒涵蓋多行。 */
function backgroundText(layout, st, rawLines, vww, vwh){
  const line = rawLines[Math.min(layout.lineIndex, rawLines.length - 1)] || '';
  if(!line) return '';
  const x = Math.round((st.posX / 100) * vww);
  const y = Math.round((st.posY / 100) * vwh);
  const metrics = subtitleBackgroundCssMetrics(st, 1);
  const topNudge = st.valign === 'bottom' ? metrics.padY : 0;
  const top = Math.round(y + layout.offsetY - topNudge);
  const fontSize = Math.max(1, Number(st.fontSize) || STYLE_DEFAULTS.fontSize);
  // 將原生底色字形的垂直尺度拉到 frozen DOM 整塊高度，再以 ybord 留出
  // ascent/descent 安全邊；水平不做比例猜測，直接由 libass 以最寬行排出。
  const scaleY = Math.max(1, 100 * Math.sqrt(layout.height / fontSize));
  const rotate = st.angle ? `\\org(${x},${y})\\frz${-(st.angle || 0)}` : '';
  return `{\\an${backgroundTopAlignment(st)}\\pos(${x},${top})${rotate}`+
    `\\1a&HFF&\\fscy${scaleY.toFixed(2)}\\xbord${metrics.padX.toFixed(1)}`+
    `\\ybord${metrics.padY.toFixed(1)}}${assEscapeText(line)}`;
}

/* 舊版用 `//` 或兩個反斜線表示人工換行。URI 內的雙斜線是資料本身，
   包含 scheme 分隔與後續 path 中的 `//`，不可被誤切成多行。 */
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
  /* vww / vwh ＝ 字幕畫布（PlayResX / PlayResY），見 CONTEXT.md「字幕畫布」。
     ── 這裡曾經還有三個參數 `vw=1920, vh=1080, ww=1920` 卡在 tracks 與 vww 之間，
        而它們在整個函式體內【一次都沒有被引用】。呼叫端因此得把三個沒有作用的數字
        填在正確的位置上，填錯不會有任何徵兆（預設值 1000/562 是看起來合理的數字，
        不是明顯錯誤的值）。實際呼叫長這樣：`toASS(cues, fps, tracks, RX, RY, RX, RX, RY)`
        ——五個位置只有最後兩個有意義。已移除。 */
  toASS(cues,fps,tracks=[], vww=1000, vwh=562, options={}){
    const backgroundLayouts = options?.backgroundLayouts && typeof options.backgroundLayouts === 'object'
      ? options.backgroundLayouts : {};
    const metadataPayload=options && options.includeMetadata === true
      ? buildSubtoolMetadata(cues, fps, tracks, options) : null;
    const metadata=metadataPayload ? encodeSubtoolMetadata(metadataPayload) : '';
    const head=
`[Script Info]
; Script generated by SUB Tool
; SUBTOOL-ASS-TIME:2
${metadata}ScriptType: v4.00+
WrapStyle: 0
Collisions: Normal
PlayResX: ${vww}
PlayResY: ${vwh}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
`;
    // 樣式行/文字轉換一律走 substyle.js（v4.23）：軌道樣式全欄位（字型/粗斜/字距/框線/陰影/直書/背景塊）＋
    // 逐句覆蓋（inline override）＋直書逐字＋行距墊高——與 HTML 預覽同構（同吃 effStyle）。
    let styles = '';
    if (!tracks || !tracks.length) {
      styles += styleToAssStyleLine('Default', effStyle(null, null), vwh) + '\n';
    } else {
      tracks.forEach((tk, i) => { styles += styleToAssStyleLine(`Track${i}`, effStyle(null, tk), vwh) + '\n'; });
      styles += styleToAssStyleLine('Default', effStyle(null, null), vwh) + '\n';
    }

    const eventsHead = `\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
    const vis=cues.filter(c=>{
      if(c.timed===false) return false;
      const tk = c.track || 0;
      if(tracks && tracks[tk] && tracks[tk].visible === false) return false;
      return true;
    });
    // 背景色塊只有 Style 行表達得出來（BorderStyle/BackColour 無 inline tag）→ 有覆蓋到它的句子
    // 各自帶一條專屬 Style。其餘欄位一律走 inline tag，不必為每句生 Style。
    const trkOf = c => (tracks && tracks.length > (c.track||0)) ? tracks[c.track||0] : null;
    const ownStyle = new Map(); // cue.id → Style 名
    for(const c of vis){
      if(!c.style || !STYLE_ONLY_KEYS.some(k => c.style[k] != null)) continue;
      const nm = `Cue_${String(c.id).replace(/[^A-Za-z0-9_]/g,'')}`;
      ownStyle.set(c.id, nm);
      styles += styleToAssStyleLine(nm, effStyle(c, trkOf(c)), vwh) + '\n';
    }
    const foregroundStyles = new Map();
    const foregroundStyleFor = (baseName, baseStyle) => {
      if(foregroundStyles.has(baseName)) return foregroundStyles.get(baseName);
      const name = `${baseName}_Text`;
      foregroundStyles.set(baseName, name);
      styles += styleToAssStyleLine(name, {
        ...baseStyle,
        bgBox: false,
        outline: 0,
        shadow: 0,
      }, vwh) + '\n';
      return name;
    };
    const eventHead = (c, styleName) =>
      `Dialogue: ${c.track||0},${secToASS(c.start, fps)},${secToASS(c.end, fps)},${styleName},atg${(c.track||0)+1},0,0,0,,`;
    const rendered=vis.map(c=>{
      const trk = trkOf(c);
      const st = effStyle(c, trk);
      const styName = ownStyle.get(c.id) || (trk ? `Track${c.track||0}` : 'Default');
      const layout = st.bgBox && !st.vertical
        ? finiteBackgroundLayout(backgroundLayouts[String(c.id)]) : null;
      const baseStyle = ownStyle.has(c.id) ? st : effStyle(null, trk);
      const textStyleName = layout ? foregroundStyleFor(styName, baseStyle) : styName;
      const textDiff = layout && c.style
        ? Object.fromEntries(Object.entries(c.style).filter(([key]) =>
          !['outline','outlineColor','shadow','bgBox','bgColor','bgAlpha'].includes(key)))
        : c.style;
      const tags = cueAssTags(textDiff, layout ? { ...st, bgBox:false } : st);
      const head = eventHead(c, textStyleName);
      // 直書：ASS 無 writing-mode → 一列一個 Dialogue、逐列自己定位（見 verticalAssCols）。
      // 每列以 inline \an 覆蓋 Style 的 Alignment（Style 是整軌共用的，做不到逐列）。
      if(st.vertical){
        return { backgrounds:[], text:verticalAssCols(st, c.text || '', vww, vwh)
          .map(col => `${head}{\\an${col.an}\\pos(${col.x},${col.y})}${tags}${assJoinVertical(col.chars, st)}`)
          .join('\n') };
      }
      // \pos 精確落點（畫面百分比座標）＋逐句覆蓋 tags。
      // 錨點預設由 Style 的 Alignment 決定；該句自己覆蓋了對齊 → 補一個 inline \an
      // （Style 是整軌共用的，改它會動到別句）。
      const anOv = (c.style && (c.style.align != null || c.style.valign != null) && !ownStyle.has(c.id))
        ? `{\\an${assAlignN(st)}}` : '';
      // 逐行跳脫後才交給 assJoinLines——它會插入 \N 與 {\fs} 行距墊高，
      // 那些是我們自己要送的控制碼，不能跟使用者文字一起被跳脫。
      const lines = String(c.text || '').replace(/\r/g, '').split('\n').map(assEscapeText);
      const text = head + anOv + cueAssPos(st, vww, vwh) + tags +
        assJoinLines(lines, st, { suppressBackground:!!layout });
      const backgrounds = [];
      if(layout){
        const background = backgroundText(layout, st,
          String(c.text || '').replace(/\r/g, '').split('\n'), vww, vwh);
        if(background) backgrounds.push(eventHead(c, styName) + cueAssTags(c.style, st) + background);
      }
      return { backgrounds, text };
    });
    // 同一 Layer 內後面的事件畫在上面：先集中所有底色，再畫文字，避免下一句的底色
    // 蓋住前一句文字；不同 track 的 Layer 順序仍保持原有語義。
    const body=[
      ...rendered.flatMap(item => item.backgrounds),
      ...rendered.map(item => item.text),
    ].join('\n');
    return head+styles+eventsHead+body+'\n';
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

export { SubFormats, splitN, decodeLegacyLineBreaks, decodeAssDialogueText };


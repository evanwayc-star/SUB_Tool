/* 字幕樣式核心（v4.23）：樣式預設值、生效樣式解析（軌道 ⊕ 逐句覆蓋）、
   HTML/ASS 兩路轉換、直書（逐字換行＋直排標點）、常用樣式庫（config 持久化）。
   ── 鐵律：HTML 預覽與 ASS（mpv／匯出燒入共用 toASSFromState）必須同構——
   兩路都【只】吃 effStyle() 的結果，任何新欄位都要同時接兩路。 */
"use strict";
import { State } from './state.js';

/* 樣式欄位與預設值（軌道級；逐句覆蓋為其子集）。
   舊專案/既有軌道缺欄位時由 effStyle 後援——newTrack 不需要加欄位、零遷移。 */
export const STYLE_DEFAULTS = {
  font: '更紗黑體', // 預設字型＝font/ 底下的資料夾名（v4.29.4 由台北黑體改為更紗黑體）
  bold: true, italic: false,
  fontSize: 65, color: '#ffffff',
  letterSpacing: 1,     // px 字距（ASS Spacing / CSS letter-spacing）；直書時不適用（逐字換行）
  lineSpacing: 1.0,     // 行高倍數 1.0~3.0（CSS line-height；ASS 行間墊高 hack）；直書時＝字與字的間隔
  outline: 2,           // px 框線厚度（ASS Outline / CSS text-stroke）
  outlineColor: '#000000',
  shadow: 0,            // px 陰影（ASS Shadow / CSS text-shadow 右下偏移）
  vertical: false,      // 直書（單列逐字換行；原文換行以全形空格取代）
  bgBox: false, bgColor: '#000000', bgAlpha: 0.5, // 背景色塊（ASS BorderStyle=3；限軌級）
  // 位置＝畫面座標（內部存百分比＝解析度無關、專案可攜；UI／摘要以像素顯示）。
  // align/valign＝多行多句的對齊方式，同時也是文字塊對齊到座標的那一側（ASS \an 的語義）：
  //   align=center + valign=middle → 座標正好是文字塊的正中心。
  // 對應 ASS `\pos(x,y)`＋Alignment；HTML 為 left/top＋translate。舊專案的 posPct 自動當 posY。
  posX: 50, posY: 91.20370370370371, align: 'center', valign: 'bottom',
  angle: 0, // 旋轉角度（度，順時針為正；繞文字塊中心）→ ASS Style Angle／\frz（逆時針故取負）、CSS rotate
};

/* 逐句覆蓋允許的欄位＝樣式面板改得動的全部（v4.31：面板預設就是在改「選取的那一句」）。
   posX/posY 自 v4.30 納入（在預覽窗直接拖某一句＝只挪那一句）。
   align/valign 走逐句 \an；背景色塊（bgBox/bgColor/bgAlpha）ASS 只有 Style 行表達得出來、
   沒有 inline tag → 由 formats.js 為有覆蓋的句子額外生一條 Style（見 STYLE_ONLY_KEYS）。 */
export const CUE_STYLE_KEYS = ['font','bold','italic','fontSize','color','letterSpacing','lineSpacing','outline','outlineColor','shadow','vertical','angle','posX','posY','align','valign','bgBox','bgColor','bgAlpha'];

/* 只有 ASS Style 行表達得出來的欄位（無對應 inline tag）→ 該句得自帶一條 Style */
export const STYLE_ONLY_KEYS = ['bgBox','bgColor','bgAlpha'];

/* 生效樣式：預設 ⊕ 軌道 ⊕ 逐句覆蓋（cue 可為 null＝取軌道樣式） */
export function effStyle(cue, track){
  const st = Object.assign({}, STYLE_DEFAULTS);
  if(track){
    for(const k in STYLE_DEFAULTS){ if(track[k] != null) st[k] = track[k]; }
    if(track.posY == null && track.posPct != null) st.posY = track.posPct; // 舊專案：posPct→posY
  }
  if(cue && cue.style) for(const k of CUE_STYLE_KEYS){ if(cue.style[k] != null) st[k] = cue.style[k]; }
  return st;
}

/* ASS 的虛擬畫布（PlayResX/Y）。字級／框線／陰影都是相對 【PlayResY（高）】換算的
   （ScaledBorderAndShadow: yes），座標則相對兩軸。HTML 預覽必須用同一組數字換算，
   否則預覽與 mpv／匯出對不上。ASS 匯出端（subio.toASSFromState）吃的也是這個常數。 */
export const ASS_PLAY_RES = { x: 1920, y: 1080 };

/* 文字塊的錨點（align/valign 決定塊的哪一側貼齊座標）。
   HTML 用它做兩件事：容器的 translate 補償、旋轉支點（transform-origin）。 */
const ANCHOR_X = { left: 0, center: 50, right: 100 };
const ANCHOR_Y = { top: 0, middle: 50, bottom: 100 };
export function anchorPct(st){
  return { x: ANCHOR_X[st.align] ?? 50, y: ANCHOR_Y[st.valign] ?? 100 };
}
function originOf(st){ const a = anchorPct(st); return `${a.x}% ${a.y}%`; }

/* ---- HTML 預覽（videoSub 每句 span 的 inline CSS；容器只管定位/對齊，由呼叫端處理） ---- */
export function styleToCss(st, ratio){
  // ASS 規範之 Fontsize 係以 72 pt / 96 dpi 換算 (72/96 = 0.75)，libass (mpv / 匯出燒入) 會自動套用 0.75。
  // HTML DOM 預覽必須乘上 0.75，字級才能與 mpv / 匯出畫面 1:1 完美對齊。
  const fs = Math.max(10, Math.round(st.fontSize * 0.75 * r));
  let css = `font-size:${fs}px;color:${st.color};`+
    `font-family:'${st.font}','Noto Sans TC','Source Han Sans TC',sans-serif;`+
    `font-weight:${st.bold ? 700 : 400};font-style:${st.italic ? 'italic' : 'normal'};`+
    `line-height:${st.lineSpacing};`;
  if(st.letterSpacing) css += `letter-spacing:${(st.letterSpacing * r).toFixed(1)}px;`;
  // 直書：瀏覽器原生直排——多行(<br)自動分列、CJK 標點自動轉直排字形；
  // letter-spacing＝字間(縱)、line-height＝列間(橫)語義自動對。
  // vertical-【lr】＝第一行在最左、往右排（非 CJK 書籍的右→左傳統）。
  // ASS 端 verticalAssCols() 依同一方向逐列定位——改這裡務必同時改那裡。
  if(st.vertical) css += `writing-mode:vertical-lr;text-orientation:mixed;`;
  // 旋轉支點＝【錨點】，不是文字塊中心：ASS 的 \frz 繞 \org 轉，而 \org 預設就是 \pos 那一點
  // （＝Alignment 指定的那一角）。用 center center 會與匯出／mpv 轉出不同結果——只有
  // align=center+valign=middle 時兩者才恰好重合，難怪預設值下看起來像是對的。
  if(st.angle) css += `transform:rotate(${st.angle}deg);transform-origin:${originOf(st)};`;
  if(st.bgBox){
    // 在 ASS 中 BorderStyle=3 時，Outline 轉為控制底色 padding，不再畫字體外框
    const pad = (0.12 * fs + (st.outline || 0) * r).toFixed(1);
    const padH = (0.35 * fs + (st.outline || 0) * r).toFixed(1);
    css += `background:${hexToRgba(st.bgColor, st.bgAlpha)};padding:${pad}px ${padH}px;margin:-${pad}px -${padH}px;border-radius:.08em;`+
           `box-decoration-break:clone;-webkit-box-decoration-break:clone;`;
    // Shadow 轉為底色色塊的陰影
    if(st.shadow > 0){
      const d = (st.shadow * r).toFixed(1);
      css += `box-shadow:${d}px ${d}px 0px rgba(0,0,0,.85);`;
    }
  } else {
    if(st.outline > 0){
      // ASS outline 向外擴 N px；CSS stroke 置中描邊 → 寬度 2N 視覺對應，paint-order 讓筆畫墊在填色後
      css += `-webkit-text-stroke:${(st.outline * 2 * r).toFixed(1)}px ${st.outlineColor};paint-order:stroke fill;`;
    }
    if(st.shadow > 0){
      const d = (st.shadow * r).toFixed(1);
      css += `text-shadow:${d}px ${d}px ${(st.shadow * r * 0.6).toFixed(1)}px rgba(0,0,0,.85);`;
    }
  }
  return css;
}
/* 常見色的中文名（樣式摘要用；非清單內的顏色只顯示色點、不硬湊名稱） */
const COLOR_NAMES = {
  '#ffffff':'白色','#000000':'黑色','#ff0000':'紅色','#ff3333':'紅色','#00ff00':'綠色','#44cc66':'綠色',
  '#0000ff':'藍色','#3399ff':'藍色','#ffff00':'黃色','#ffee00':'黃色','#ff00ff':'洋紅','#00ffff':'青色',
  '#808080':'灰色','#cccccc':'淺灰','#333333':'深灰','#ffa500':'橘色','#800080':'紫色',
};
export function colorName(hex){ return COLOR_NAMES[String(hex||'').toLowerCase()] || ''; }

/* 樣式的畫面像素座標（內部存百分比＝解析度無關、專案可攜；UI 與摘要顯示像素） */
export function posToPx(st){
  const VW = State.videoWidth || 1920, VH = State.videoHeight || 1080;
  return { x: Math.round(st.posX / 100 * VW), y: Math.round(st.posY / 100 * VH), VW, VH };
}

export function hexToRgba(hex, a){
  const c = (hex || '#000000').replace('#', '');
  const v = c.length === 6 ? c : '000000';
  return `rgba(${parseInt(v.slice(0,2),16)},${parseInt(v.slice(2,4),16)},${parseInt(v.slice(4,6),16)},${(+a).toFixed(2)})`;
}

/* ---- ASS ---- */
/* #rrggbb → &HAABBGGRR&（AA=alpha，00=不透明、FF=全透明） */
export function hexToAssColor(hex, alpha01){
  const c = (hex || '#ffffff').replace('#', '');
  const v = c.length === 6 ? c : 'ffffff';
  const aa = alpha01 == null ? '00' : Math.round((1 - Math.max(0, Math.min(1, alpha01))) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `&H${aa}${v.slice(4,6)}${v.slice(2,4)}${v.slice(0,2)}`.toUpperCase();
}

/* 生效樣式 → ASS Alignment（\an 的 1-9 numpad）＝ 垂直基數(下1/中4/上7) ＋ 水平(左0/中1/右2)。
   Style 行與逐句 \an 共用，避免兩處各算一次而漂掉。 */
export function assAlignN(st){
  const vbase = { top: 7, middle: 4, bottom: 1 }[st.valign || 'bottom'];
  const acol = { left: 0, center: 1, right: 2 }[st.align];
  return vbase + (acol != null ? acol : 1);
}

/* 軌道生效樣式 → ASS Style 行（V4+ 欄位序）。name=樣式名；vwh=PlayResY（MarginV 換算用） */
export function styleToAssStyleLine(name, st, vwh){
  // Alignment 1-9（numpad）＝ 垂直基數(下1/中4/上7) ＋ 水平(左0/中1/右2)；直書一律上錨。
  // 實際落點由每句的 \pos(x,y) 決定（見 cueAssPos），故 MarginV 僅作為無 \pos 時的後援。
  const va = st.vertical ? 'top' : (st.valign || 'bottom');
  const vbase = { top: 7, middle: 4, bottom: 1 }[va];
  const acol = { left: 0, center: 1, right: 2 }[st.align];
  const alignN = vbase + (acol != null ? acol : 1);
  const mv = va === 'middle' ? 0
           : va === 'top' ? Math.round(vwh * (st.posY / 100))            // 距頂
           : Math.round(vwh * ((100 - st.posY) / 100));                  // 距底
  const borderStyle = st.bgBox ? 3 : 1;
  const backCol = st.bgBox ? hexToAssColor(st.bgColor, st.bgAlpha) : '&H00000000';
  const shadowV = st.bgBox ? Math.max(1, st.shadow) : st.shadow; // BorderStyle=3 需 Outline/Shadow 撐出色塊範圍
  const outlineCol = st.bgBox ? backCol : hexToAssColor(st.outlineColor);
  // Fontname 走 assFontName()：ASS 要的是字型檔內部家族名，不是 UI 的資料夾名
  return `Style: ${name},${assFontName(st.font)},${st.fontSize},${hexToAssColor(st.color)},&H00FFFFFF,${outlineCol},${backCol},`+
    `${st.bold ? 1 : 0},${st.italic ? 1 : 0},0,0,100.0,100.0,${st.vertical ? 0 : st.letterSpacing},${(-(st.angle || 0)).toFixed(1)},`+
    `${borderStyle},${st.outline},${shadowV},${alignN},135,135,${mv},1`;
}

/* 畫面座標 → ASS `{\pos(x,y)}`（相對 PlayResX/Y）。錨點由 Style 的 Alignment 決定，
   兩者合起來＝「文字塊的哪一側」對齊「畫面上的哪一點」，與 HTML 的 left/top＋translate 同構。 */
export function cueAssPos(st, vww, vwh){
  const x = Math.round((st.posX / 100) * vww);
  const y = Math.round((st.posY / 100) * vwh);
  return `{\\pos(${x},${y})}`;
}

/* 逐句覆蓋（diff＝cue.style）→ ASS inline override tags（貼在 Dialogue 文字最前）。無覆蓋回空字串 */
export function cueAssTags(diff){
  if(!diff) return '';
  let t = '';
  if(diff.font != null) t += `\\fn${assFontName(diff.font)}`; // 同 Style：ASS 認的是內部家族名
  if(diff.fontSize != null) t += `\\fs${diff.fontSize}`;
  if(diff.color != null) t += `\\c${hexToAssColor(diff.color)}&`;
  if(diff.bold != null) t += `\\b${diff.bold ? 1 : 0}`;
  if(diff.italic != null) t += `\\i${diff.italic ? 1 : 0}`;
  if(diff.letterSpacing != null) t += `\\fsp${diff.letterSpacing}`;
  if(diff.outline != null) t += `\\bord${diff.outline}`;
  if(diff.outlineColor != null) t += `\\3c${hexToAssColor(diff.outlineColor)}&`;
  if(diff.shadow != null) t += `\\shad${diff.shadow}`;
  if(diff.angle != null) t += `\\frz${-diff.angle}`; // ASS \frz 逆時針為正 → 取負
  return t ? `{${t}}` : '';
}

/* ---- 直書：直排標點映射 ---- */
const VERT_PUNCT = {
  '，':'︐','。':'︒','、':'︑','：':'︓','；':'︔','！':'︕','？':'︖',
  '「':'﹁','」':'﹂','『':'﹃','』':'﹄','（':'﹙','）':'﹚','《':'︽','》':'︾',
  '〈':'︿','〉':'﹀','【':'︻','】':'︼','…':'⋮','—':'｜','–':'｜','ー':'｜',
  ',':'︐','.':'︒','!':'︕','?':'︖',':':'︓',';':'︔','(':'﹙',')':'﹚','~':'｜',
};
/* 回傳逐字陣列（已映射直排標點；\n→全形空格）。HTML 端每字 escape 後 join('<br>') */
export function verticalChars(text){
  const flat = String(text || '').replace(/\r/g, '').replace(/\n/g, '　');
  const out = [];
  for(const ch of flat) out.push(VERT_PUNCT[ch] || ch);
  return out;
}

/* 行距 hack：ASS 無行距欄位——行間插入一個「高度=gapPx 的 \h 空白行」，之後恢復字級 fsPx。
   lineSpacing<=1 時原樣不動。 */
export function assJoinLines(lines, st){
  const fs = st.fontSize;
  const gap = Math.round((Math.max(1, st.lineSpacing) - 1) * fs);
  if(gap <= 0) return lines.join('\\N');
  return lines.join(`\\N{\\fs${gap}}\\h\\N{\\fs${fs}}`);
}

/* 直書單列：逐字換行；字與字之間插入「高度＝字距」的空白行。
   （Style 的 Spacing 是「行內字距」，逐字換行後每字自成一行 → 對它無效，故走同一套墊高 hack） */
export function assJoinVertical(chars, st){
  const gap = Math.round(st.letterSpacing || 0);
  const fs = st.fontSize;
  let res = '';
  let needsFsRestore = false;
  for(let i=0; i<chars.length; i++){
    let ch = chars[i];
    if(needsFsRestore){
      ch = `{\\fs${fs}}` + ch;
      needsFsRestore = false;
    }
    if(ch === ' ' || ch === `{\\fs${fs}} `){
      // 修正：半形空白在 ASS 直書（以 \N 切割逐列排版）時，若獨佔一行會佔用一整個全形字元的高度。
      // 這裡將半形空白暫時替換為「一半字級的不可見空格 \h」，使其視覺高度縮減為一半，模擬正確的直書半形間距。
      const half = Math.round(fs * 0.5);
      ch = `{\\fs${half}}\\h`;
      // 標記下一列必須還原回原本的字體大小，避免後續字元繼承到縮小一半的字級。
      needsFsRestore = true;
    }
    if(i > 0){
      if(gap > 0){
        res += `\\N{\\fs${gap}}\\h\\N${needsFsRestore ? '' : '{\\fs'+fs+'}'}`;
      } else {
        res += `\\N`;
      }
    }
    res += ch;
  }
  return res;
}

/* 直書 → ASS 多列：ASS 沒有 writing-mode，故【一列一個 Dialogue】自己排。
   回 [{chars, x, y, an}]，列序左→右（第一行在最左，與 HTML 的 vertical-lr 同構）。

   ── y 不自己算：交給 libass。valign→\an（上8/中5/下2）讓每列各自貼齊同一條基準線，
      正好等於「多列之間上／中／下對齊」的語義。各列長度不同、且 ASS 行高並非剛好等於
      字級，硬估文字高度必歪——這樣就完全不必估。
   ── x 自己算：列距＝fontSize×lineSpacing，恰為 CSS `line-height:<number>` 在直書時的
      水平步進 → 與預覽同一個數。整塊寬 W＝列數×列距，再依 align 決定哪一側對齊 posX
      （對應 HTML 容器的 translate 補償）。 */
export function verticalAssCols(st, text, vww, vwh){
  const cols = String(text || '').replace(/\r/g, '').split('\n').map(l => verticalChars(l));
  const colW = st.fontSize * Math.max(1, st.lineSpacing);
  const W = cols.length * colW;
  const X = (st.posX / 100) * vww, Y = Math.round((st.posY / 100) * vwh);
  const left = st.align === 'left' ? X : st.align === 'right' ? X - W : X - W / 2;
  const an = { top: 8, middle: 5, bottom: 2 }[st.valign || 'bottom'];
  return cols.map((chars, i) => ({ chars, x: Math.round(left + i * colW + colW / 2), y: Y, an }));
}

/* ---- 常用樣式庫（跨專案；桌面存 config.json、網頁存 localStorage） ---- */
/* 內建預設樣式：不可改名／刪除／編輯，永遠排在第一個，供隨時一鍵回到標準字幕外觀。
   內容＝STYLE_DEFAULTS 本身（字級80／白字／黑框2／陰影0／中對齊＋下對齊／粗體／
   座標(50%,90%)＝水平置中且貼齊 80% 安全框底線／角度0／無底色／字距行距皆 1）。
   ── 刻意直接引用 STYLE_DEFAULTS 而非另抄一份：兩份會漂掉。 */
export const BUILTIN_PRESETS = [
  { name: '預設', builtin: true, style: { ...STYLE_DEFAULTS } },
];
const LS_KEY = 'subtool.subPresets';
let _presets = null; // [{name, style:{...軌道級欄位子集}}]（僅使用者自訂；內建的不存檔）
export async function loadPresets(){
  if(_presets) return _presets;
  try{
    const DESK = window.subtool;
    if(DESK && DESK.configLoad){ const conf = await DESK.configLoad(); _presets = Array.isArray(conf.subPresets) ? conf.subPresets : []; }
    else _presets = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  }catch(e){ _presets = []; }
  
  if (_presets) {
    let migrated = false;
    _presets.forEach(p => {
      if (!p.group && p.name && p.name.indexOf('-') > 0) {
        const idx = p.name.indexOf('-');
        p.group = p.name.substring(0, idx).trim();
        p.name = p.name.substring(idx + 1).trim();
        migrated = true;
      }
    });
    if (migrated) savePresets(_presets);
  }
  return _presets;
}
export function getPresets(){ return _presets || []; }        // 僅使用者自訂（可改名／刪除／存檔）
/* 給 UI 用的完整清單＝內建（永遠第一）＋使用者自訂。內建那筆帶 builtin:true，
   呼叫端據此隱藏改名／刪除。 */
export function getAllPresets(){ return [...BUILTIN_PRESETS, ...(_presets || [])]; }
export function isBuiltinPresetName(name){ return BUILTIN_PRESETS.some(p => p.name === name); }
export function savePresets(list){
  _presets = (list || []).filter(p => p && !isBuiltinPresetName(p.name)); // 內建的永不寫進使用者清單
  try{
    const DESK = window.subtool;
    if(DESK && DESK.configSave) DESK.configSave({ subPresets: _presets });
    else localStorage.setItem(LS_KEY, JSON.stringify(_presets));
  }catch(e){}
}
/* ---- 字幕字型（v4.25.4）：桌面版掃 <專案根>/font/，以 FontFace 註冊供預覽；
   匯出（libass）由主程序以 fontsdir 指向同一資料夾 → 預覽＝燒錄同一份字型。 ---- */
let _fonts = null; // [{name:資料夾名（UI／CSS 用）, file, family:檔案內部家族名（ASS 用）}]
export function getFonts(){ return _fonts || []; }

/* 資料夾名 → ASS Fontname（v4.29.3 修）。
   ── libass／fontconfig 只認字型檔【內部的家族名】；我們 UI 用的是使用者自取的資料夾名
      （「台北黑體」vs 檔內的 "Taipei Sans TC Beta"）。直接把資料夾名填進 ASS，libass 找不到
      就【靜默】退回系統字型 → 匯出／mpv 與預覽字型不同，且毫無錯誤訊息。
   不在自備清單者（使用者自填的系統字型名）原樣傳回。 */
export function assFontName(name){
  const f = getFonts().find(x => x.name === name);
  return (f && f.family) || name;
}
export async function loadFonts(force = false){
  if(_fonts && !force) return _fonts;
  _fonts = [];
  try{
    const DESK = window.subtool;
    if(!DESK || !DESK.fontsList) return _fonts;
    const r = await DESK.fontsList();
    // 預設字型排第一（主行程給的是資料夾名字典序）；其餘維持原順序。
    const list = ((r && r.fonts) || []).slice()
      .sort((a, b) => (b.name === STYLE_DEFAULTS.font) - (a.name === STYLE_DEFAULTS.font));
    // 以 FontFace API 直接餵位元組註冊——CSS `@font-face{src:url('file://…')}` 會被
    // Chromium 擋下（"A network error occurred"），即使 webSecurity 關閉亦然。
    for(const f of list){
      try{
        const url = await DESK.fileURL(f.file);
        const buf = await (await fetch(url)).arrayBuffer();
        const face = new FontFace(f.name, buf);
        await face.load();
        document.fonts.add(face);
        _fonts.push(f);
      }catch(e){ console.warn('[fonts] 載入失敗：' + f.name, String(e && e.message || e)); }
    }
  }catch(e){ console.warn('[fonts] load', e); }
  return _fonts;
}

/* 從軌道取可存為 preset 的樣式子集（不含 name/visible/locked 等非樣式欄位） */
export function trackStyleSnapshot(track){ return styleSnapshot(effStyle(null, track)); }

/* 生效樣式 → 可存入常用樣式庫的純物件：只挑 STYLE_DEFAULTS 的欄位，
   濾掉軌道自己的 name／visible／locked 等非樣式屬性。 */
export function styleSnapshot(st){
  const out = {};
  for(const k in STYLE_DEFAULTS) out[k] = st[k];
  return out;
}

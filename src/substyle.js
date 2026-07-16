/* 字幕樣式核心（v4.23）：樣式預設值、生效樣式解析（軌道 ⊕ 逐句覆蓋）、
   HTML/ASS 兩路轉換、直書（逐字換行＋直排標點）、常用樣式庫（config 持久化）。
   ── 鐵律：HTML 預覽與 ASS（mpv／匯出燒入共用 toASSFromState）必須同構——
   兩路都【只】吃 effStyle() 的結果，任何新欄位都要同時接兩路。 */
"use strict";

/* 樣式欄位與預設值（軌道級；逐句覆蓋為其子集）。
   舊專案/既有軌道缺欄位時由 effStyle 後援——newTrack 不需要加欄位、零遷移。 */
export const STYLE_DEFAULTS = {
  font: '台北黑體',
  bold: true, italic: false,
  fontSize: 60, color: '#ffffff',
  letterSpacing: 1,     // px 字距（ASS Spacing / CSS letter-spacing）；直書時不適用（逐字換行）
  lineSpacing: 1.0,     // 行高倍數 1.0~3.0（CSS line-height；ASS 行間墊高 hack）；直書時＝字與字的間隔
  outline: 2,           // px 框線厚度（ASS Outline / CSS text-stroke）
  outlineColor: '#000000',
  shadow: 0,            // px 陰影（ASS Shadow / CSS text-shadow 右下偏移）
  vertical: false,      // 直書（單列逐字換行；原文換行以全形空格取代）
  bgBox: false, bgColor: '#000000', bgAlpha: 0.5, // 背景色塊（ASS BorderStyle=3；限軌級）
  // 位置＝畫面百分比座標（v4.26）：posX/posY 決定字幕落點，align/valign 是「錨點」（文字塊的哪一側對齊該座標）。
  // 對應 ASS 的 \pos(x,y) ＋ Alignment(\an)；HTML 則為 left/top ＋ translate。舊專案的 posPct 自動當 posY。
  posX: 50, posY: 90, align: 'center', valign: 'bottom',
};

/* 逐句覆蓋允許的欄位（位置/對齊/背景塊屬軌道級語義，不入逐句） */
export const CUE_STYLE_KEYS = ['font','bold','italic','fontSize','color','letterSpacing','lineSpacing','outline','outlineColor','shadow','vertical'];

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

/* ---- HTML 預覽（videoSub 每句 span 的 inline CSS；容器只管定位/對齊，由呼叫端處理） ---- */
export function styleToCss(st, ratio){
  const r = ratio || 1;
  const fs = Math.max(12, Math.round(st.fontSize * r));
  let css = `font-size:${fs}px;color:${st.color};`+
    `font-family:'${st.font}','Noto Sans TC','Source Han Sans TC',sans-serif;`+
    `font-weight:${st.bold ? 700 : 400};font-style:${st.italic ? 'italic' : 'normal'};`+
    `line-height:${st.lineSpacing};`;
  if(st.letterSpacing) css += `letter-spacing:${(st.letterSpacing * r).toFixed(1)}px;`;
  // 直書：瀏覽器原生直排——多行(<br>)自動分列(右→左)、CJK 標點自動轉直排字形；
  // letter-spacing＝字間(縱)、line-height＝列間(橫)語義自動對。
  if(st.vertical) css += `writing-mode:vertical-rl;text-orientation:mixed;`;
  if(st.outline > 0){
    // ASS outline 向外擴 N px；CSS stroke 置中描邊 → 寬度 2N 視覺對應，paint-order 讓筆畫墊在填色後
    css += `-webkit-text-stroke:${(st.outline * 2 * r).toFixed(1)}px ${st.outlineColor};paint-order:stroke fill;`;
  }
  if(st.shadow > 0){
    const d = (st.shadow * r).toFixed(1);
    css += `text-shadow:${d}px ${d}px ${(st.shadow * r * 0.6).toFixed(1)}px rgba(0,0,0,.85);`;
  }
  if(st.bgBox){
    css += `background:${hexToRgba(st.bgColor, st.bgAlpha)};padding:.12em .35em;border-radius:.08em;`+
           `box-decoration-break:clone;-webkit-box-decoration-break:clone;`;
  }
  return css;
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
  return `Style: ${name},${st.font},${st.fontSize},${hexToAssColor(st.color)},&H00FFFFFF,${hexToAssColor(st.outlineColor)},${backCol},`+
    `${st.bold ? 1 : 0},${st.italic ? 1 : 0},0,0,100.0,100.0,${st.vertical ? 0 : st.letterSpacing},0.0,`+
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
  if(diff.font != null) t += `\\fn${diff.font}`;
  if(diff.fontSize != null) t += `\\fs${diff.fontSize}`;
  if(diff.color != null) t += `\\c${hexToAssColor(diff.color)}&`;
  if(diff.bold != null) t += `\\b${diff.bold ? 1 : 0}`;
  if(diff.italic != null) t += `\\i${diff.italic ? 1 : 0}`;
  if(diff.letterSpacing != null) t += `\\fsp${diff.letterSpacing}`;
  if(diff.outline != null) t += `\\bord${diff.outline}`;
  if(diff.outlineColor != null) t += `\\3c${hexToAssColor(diff.outlineColor)}&`;
  if(diff.shadow != null) t += `\\shad${diff.shadow}`;
  return t ? `{${t}}` : '';
}

/* ---- 直書（單列逐字）：直排標點映射；原文換行 → 全形空格（第一版單列，多列直排留待後續） ---- */
const VERT_PUNCT = {
  '，':'︐','。':'︒','、':'︑','：':'︓','；':'︔','！':'︕','？':'︖',
  '「':'﹁','」':'﹂','『':'﹃','』':'﹄','（':'﹙','）':'﹚','《':'︽','》':'︾',
  '〈':'︿','〉':'﹀','【':'︻','】':'︼','…':'⋮','—':'｜','–':'｜','ー':'｜',
  ',':'︐','.':'︒','!':'︕','?':'︖',':':'︓',';':'︔','(':'﹙',')':'﹚','~':'｜',
};
/* 回傳逐字陣列（已映射直排標點；\n→全形空格）。ASS 端 join('\\N')、HTML 端每字 escape 後 join('<br>') */
export function verticalChars(text){
  const flat = String(text || '').replace(/\r/g, '').replace(/\n/g, '　');
  const out = [];
  for(const ch of flat) out.push(VERT_PUNCT[ch] || ch);
  return out;
}

/* 行距 hack：ASS 無行距欄位——行間插入一個「高度=gapPx 的 \h 空白行」，之後恢復字級 fsPx。
   直書＝每字之間插（lineSpacing 在直書＝字間隔）。lineSpacing<=1 時原樣不動。 */
export function assJoinLines(lines, st){
  const fs = st.fontSize;
  const gap = Math.round((Math.max(1, st.lineSpacing) - 1) * fs);
  if(gap <= 0) return lines.join('\\N');
  return lines.join(`\\N{\\fs${gap}}\\h\\N{\\fs${fs}}`);
}

/* ---- 常用樣式庫（跨專案；桌面存 config.json、網頁存 localStorage） ---- */
const LS_KEY = 'subtool.subPresets';
let _presets = null; // [{name, style:{...軌道級欄位子集}}]
export async function loadPresets(){
  if(_presets) return _presets;
  try{
    const DESK = window.subtool;
    if(DESK && DESK.configLoad){ const conf = await DESK.configLoad(); _presets = Array.isArray(conf.subPresets) ? conf.subPresets : []; }
    else _presets = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  }catch(e){ _presets = []; }
  return _presets;
}
export function getPresets(){ return _presets || []; }
export function savePresets(list){
  _presets = list;
  try{
    const DESK = window.subtool;
    if(DESK && DESK.configSave) DESK.configSave({ subPresets: list });
    else localStorage.setItem(LS_KEY, JSON.stringify(list));
  }catch(e){}
}
/* ---- 字幕字型（v4.25.4）：桌面版掃 <專案根>/font/，注入 @font-face 供預覽；
   匯出（libass）由主程序以 fontsdir 指向同一資料夾 → 預覽＝燒錄同一份字型。 ---- */
let _fonts = null; // [{name,file}]
export function getFonts(){ return _fonts || []; }
export async function loadFonts(){
  if(_fonts) return _fonts;
  _fonts = [];
  try{
    const DESK = window.subtool;
    if(!DESK || !DESK.fontsList) return _fonts;
    const r = await DESK.fontsList();
    const list = (r && r.fonts) || [];
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
export function trackStyleSnapshot(track){
  const st = effStyle(null, track), out = {};
  for(const k in STYLE_DEFAULTS) out[k] = st[k];
  return out;
}

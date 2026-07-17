/* SUB Tool — 協調層 / 進入點（非 hub）
   職責：載入並組裝各模組、訂閱事件匯流排(events.js)、處理影片事件、指令分派(doAction)、
   面板與選單接線、初始化(init/initDesktop)。
   架構重點：其他模組「不再 import app.js」——它們以 emit(...) 發送事件，由本檔以 on(...) 訂閱
   後呼叫對應的渲染/指令函式（renderAll、renderVideoSub、onDurationKnown、doAction… 見下方註冊區）。
   渲染協調函式(renderAll/renderVideoSub/ensurePlayheadVisible…)仍定義於此並供本檔內部直接呼叫。 */
"use strict";
import _logoUrl from './logo.png';
import { clamp, pad, decodeText, encodeUTF16LE, downloadBytes, readFile, pickFile, b64ToBytes, bytesToB64, baseName, escapeHTML } from './util.js';
import { fmtClock, secToSRT, secToASS, secToEncore, getExactFps, srtToSec, assToSec, encoreToSec, snapTimeToFrame } from './time.js';
import { SubFormats, splitN } from './formats.js';
import { $, video, tlScroll, tlLayer, tlTracks, rulerCv, waveCv, sublist } from './dom.js';
import { State, newTrack, syncTrackCount, FPS_SET, snapFps, setFps, ensureTrackCount, trackVisible, newId, DESK, IS_DESKTOP, isSel, cueSuffix, loadConfig, saveConfig, loadKeys, saveKeys } from './state.js';
import { Media, Wave } from './media.js';
import { RULER_H, WAVE_H, ROW_H, tracksTop, tracksScrollTop, viewportW, timeToX, xToTime, layoutTimeline, drawRuler, niceStep, fmtTick, drawWave, renderTrackRows, renderCueBlocks, trackFromY, addTrack, removeTrack, moveSelectedToTrack, updatePlayhead, drawTimeline, setZoom, zoomFit, zoomFitVideo, refreshTrackGutterActive, snapTargets, snapVal, neighborBounds } from './timeline.js';
import { renderSubList, renderCheckPanel, renderSubRow, selectCue, selectCueSingle, refreshSelectionUI, updateTlSel, addCue, addCueRelative, deleteSelected, deleteCue, sortCues, searchUpdate, searchNav, searchReplace, searchSelectAll, trimTrackSpaces, snapAllCuesToFrames, refreshStyleSummaries } from './subtitles.js';
import { setIn, setOut, nudge, stepBoundary, resetPlaybackSpeed } from './keyboard.js';
import { Project, ensureProjectSaved, resetProject, isProjectDirty } from './project.js';
import { showCtx, hideCtx, showCueMenu, showPlayerMenu } from './menus.js';
import { History, recordHistory, renderHistory } from './history.js';
import { pocTest as _wcPocTest, demuxFile as _wcDemux, TrackDecoder as _wcTrackDecoder, demuxIndex as _wcDemuxIndex, SampleReader as _wcSampleReader } from './decode/poc.js'; // 階段0 PoC：WebCodecs 解碼驗證（掛 window.SUB.WC）
import { WCPreview } from './decode/player.js'; // 階段1：WebCodecs 接管原生預覽畫面（rafLoop 每幀 tick）
import { effStyle, styleToCss, verticalChars, STYLE_DEFAULTS, CUE_STYLE_KEYS, loadPresets, getPresets, savePresets, trackStyleSnapshot, loadFonts, getFonts, posToPx, anchorPct } from './substyle.js'; // v4.23 字幕樣式系統
import { addNote, renderNotes, exportNotes, setNoteActive, updateNoteActive, clearAllNotes } from './notes.js';
import { setStatus, showToast, showOsd, openModal, closeModal } from './ui.js';
import { renderAudioTracks, renderMixer, mixerReset, mixerMuteAll, updateMeters } from './mixer.js';
import { showSettingsModal } from './settings.js';
import { importSub, showExportDialog, exportSub, showFpsConvertDialog, applyTcShift, applyDurAdjTc, applyDurAdjPct, toASSFromState, showExportVideoDialog } from './subio.js';
import { parseTimecodeInput, setupTimecodeInput } from './tcparse.js';
import { on, emit } from './events.js';

if (typeof __APP_VERSION__ !== 'undefined') {
  const el = document.getElementById('appVersion');
  if (el) el.textContent = 'v' + __APP_VERSION__;
}

/* app.js 為協調層：訂閱各模組發送的事件並呼叫對應的渲染/指令函式。
   各模組只 emit、不再反向 import app.js，藉此切斷雙向相依。
   （函式宣告會被 hoist，於此處註冊安全；emit 為同步呼叫，語意不變。） */
on('render:all', renderAll);
on('render:videoSub', renderVideoSub);
on('render:listTrackSel', renderListTrackSel);
on('render:trackStyle', renderTrackStyle);
on('playhead:ensure', ensurePlayheadVisible);
on('duration:known', onDurationKnown);
on('mpv:refreshSubs', refreshMpvSubs);
on('panel:toggle', togglePanel);
on('note:openInPanel', openNoteInPanel);
on('cue:openEdit', openCueEditModal);
on('action', doAction);
on('mpv:sync', _syncMpvPanel); // 自訂視窗（快捷鍵設定、右鍵選單）開閉時重算 mpv 讓位
on('history:record', recordHistory); // 供 media.js 等低階模組記錄歷史（避免 media→history 循環相依）
// A1：fps 變更後的 DOM 同步（原本在 state.setFps 內，現下沉到此處，state.js 不再相依 DOM）
on('fps:changed', ()=>{
  const sel=$('fpsSel'); if(sel) sel.value=State.dropFrame?String(State.fps)+'df':String(State.fps);
  $('tcCur').textContent=secToEncore(video.currentTime||0,State.fps,State.dropFrame);
  $('tcDur').textContent=secToEncore(State.duration,State.fps,State.dropFrame);
  
  setTimeout(() => {
    if(snapAllCuesToFrames()){
      renderSubList();
      drawTimeline();
    }
  }, 0);
});

/* ============================================================================
   SUB TOOL — 線上上字幕工具  (single-file, vanilla JS)
   區段：
     0. 全域狀態
     1. 工具函式（時間/編碼/檔案）
     2. 字幕格式 解析 / 序列化  (SRT / ASS / Encore / TXT)
     3. 媒體引擎（影片 + Web Audio 多音軌混音 + ffmpeg.wasm）
     4. 波形
     5. 時間軸 渲染 / 互動
     6. 字幕列表
     7. 鍵盤 (I/O 上字幕)
     8. 專案 存/讀 (.subtool)
     9. UI 接線 / 初始化
   ============================================================================ */

/* ===== 0. 全域狀態 ===================================================== */







/* 工具/時間/格式 已拆分至 util.js / time.js / formats.js */





/* ===== 9. UI 接線 / 渲染 / 初始化 ==================================== */
function renderAll(){ renderSubList(); renderCueBlocks(); renderVideoSub(); updateTlSel(); refreshMpvSubs(); }
/* mpv 嵌入模式：字幕改由 mpv/libass 渲染（DOM 疊層被覆蓋）。cue 變動時重建 .ass 餵給 mpv（防抖） */
let _mpvSubT=null;
let _firstLoad=true; // 第一次載入影片或字幕時自動 zoomFitVideo；新專案後重置
function refreshMpvSubs(){
  if(!Media.mpvMode || !window.subtool?.mpv) return;
  clearTimeout(_mpvSubT);
  _mpvSubT=setTimeout(()=>{
    try{
      // 序列：mpv/libass 以【來源時間】渲染字幕，而 cue 時碼為【時間軸時間】——
      // 依當前 clip 的映射（來源 = 時間軸 - offset + in）整批平移後再餵給 mpv
      let cs=State.cues;
      const c=Media.seqOn() ? Media._activeClip() : null;
      if(c && (c.offset!==0 || c.in!==0)){
        const sh=c.in - c.offset;
        cs=State.cues.map(x=>x.timed===false?x:{...x, start:x.start+sh, end:x.end+sh});
      }
      window.subtool.mpv.subSet(toASSFromState(cs)).catch(()=>{});
    }catch(e){}
  },150);
}
/* mpv 是 OS 層子視窗，無法被 HTML z-index 蓋過。
   只在浮動面板/搜尋視窗「實際重疊」影片區域時才隱藏 mpv，不重疊時影片繼續顯示。 */
function _syncMpvPanel(){
  if(!Media.mpvMode || !window.subtool?.mpv) return;
  const modalOpen=!!$('modalBg')?.classList.contains('show');
  // 快捷鍵設定是獨立於 modalBg 的自訂對話框（settings.js 自建 #settingsModal），
  // 同樣會被 mpv 蓋住，開啟期間一律讓位
  const settingsOpen=!!document.getElementById('settingsModal');
  // 序列間隙（時間軸上無影片的區段）：畫面應為黑 → mpv 讓位
  // WC 接管（proxy 就緒、WebCodecs 合成呈現中）：mpv 視窗一律讓位（僅供時鐘＋聲音兜底）
  let hides=modalOpen||settingsOpen||!!Media._gap||!!Media._wcTakeover;
  if(!hides){
    const vr=$('videoWrap')?.getBoundingClientRect();
    if(vr){
      const ov=(r)=>!(r.right<=vr.left||r.left>=vr.right||r.bottom<=vr.top||r.top>=vr.bottom);
      for(const p of document.querySelectorAll('.float-panel.show')){
        if(ov(p.getBoundingClientRect())){hides=true;break;}
      }
      if(!hides){
        const sd=$('searchDialog');
        if(sd&&(sd.style.display||'none')!=='none'&&ov(sd.getBoundingClientRect()))hides=true;
      }
      if(!hides){
        // 右鍵選單常直接開在影片上（播放窗右鍵切音源/速度），重疊時也讓位
        const cm=$('ctxmenu');
        if(cm&&cm.classList.contains('show')&&ov(cm.getBoundingClientRect()))hides=true;
      }
    }
  }
  window.subtool.mpv.show(!hides).catch(()=>{});
}
const _videoSub = $('videoSub');
const _videoWrap = $('videoWrap');
let _videoSubSig = '';
/* 影片畫面在 videoWrap 內的實際顯示區（contain）。字幕層對齊它 ——
   否則字幕框固定 16:9，遇到不同比例的片（2.39:1 電影 vs 16:9）畫面高度不同，
   字幕卻照同一個框換算 →「字幕大小在各個影片上不一樣」。回 null＝取不到來源尺寸。 */
function _stageRect(){
  if(!_videoWrap) return null;
  const W = _videoWrap.clientWidth, H = _videoWrap.clientHeight;
  if(!W || !H) return null;
  // 專案輸出解析度優先（與匯出同一張畫布 → 字幕大小不隨各片解析度/比例改變）
  let vw = State.videoWidth || 0, vh = State.videoHeight || 0;
  if(!vw || !vh){
    const ss = WCPreview.stageSize && WCPreview.stageSize();
    if(ss){ vw = ss.w; vh = ss.h; }
    else if(video.videoWidth){ vw = video.videoWidth; vh = video.videoHeight; }
  }
  if(!vw || !vh) return null;
  const s = Math.min(W/vw, H/vh);
  const dw = Math.max(1, Math.round(vw*s)), dh = Math.max(1, Math.round(vh*s));
  return { x: Math.round((W-dw)/2), y: Math.round((H-dh)/2), w: dw, h: dh };
}
function renderVideoSub(){
  // 防禦①：非 mpv（或 WC 已接管）時字幕層必須可見——避免被 mpv 載入殘留的 display:none 卡住而「完全不顯示」
  if(_videoSub && (!Media.mpvMode || Media._wcTakeover) && _videoSub.style.display==='none') _videoSub.style.display='';
  const t=Media.displayTime();
  const fps = State.fps || 25;
  let exactFps = getExactFps(fps);
  const currentFrame = Math.round(t * exactFps);

  // 字幕層對齊影片實際畫面區（v4.25.3）：大小/位置以「畫面」為基準，各片比例不同也一致
  const rect = _stageRect();
  if(rect && _videoSub){
    const key = rect.x+'|'+rect.y+'|'+rect.w+'|'+rect.h;
    if(_videoSub.dataset.rect !== key){
      _videoSub.dataset.rect = key;
      const st = _videoSub.style; // 逐項設定（不可用 cssText：會清掉 display，破壞 mpv/接管的顯示控制）
      st.position='absolute'; st.left=rect.x+'px'; st.top=rect.y+'px';
      st.width=rect.w+'px'; st.height=rect.h+'px';
      st.right='auto'; st.bottom='auto'; st.margin='0';
      st.aspectRatio='auto'; st.maxWidth='none'; st.maxHeight='none';
    }
  }
  // 每個可見軌道各依其樣式疊加顯示（v4.23：樣式一律走 substyle.effStyle——與 ASS/mpv/匯出同構）
  const playerWidth = (rect && rect.w) || _videoSub?.clientWidth || 1920;
  const ratio = playerWidth / 1920;
  let html='', sig=(rect ? rect.w+'x'+rect.h : '')+';'; // 畫面區變動（換片/不同比例/視窗縮放）須重繪
  try{
  for(let tk=0; tk<State.trackCount; tk++){
    if(!trackVisible(tk))continue;
    const cur=State.cues.filter(c => {
      if ((c.track||0)!==tk || c.timed===false) return false;
      const startFrame = Math.round(c.start * exactFps);
      const endFrame = Math.round(c.end * exactFps);
      return currentFrame >= startFrame && currentFrame < endFrame;
    });
    if(!cur.length)continue;
    const trk=State.tracks[tk]||{};
    const grab = trk.locked ? '' : ' drag'; // 鎖定軌不可拖
    // v4.30：【一句一個容器】——座標已可逐句覆蓋（在預覽窗拖某一句＝只挪那一句），
    // 各句的 posX/posY 可能不同，無法再共用一個軌級容器。
    // 同時也修掉一項預覽與 ASS 的落差：同軌同時段的多句，ASS 本來就是各自 \pos 疊著畫，
    // 舊版預覽卻用 <br> 把它們串成一疊 → 看到的跟燒出來的不一樣（第二句仍標紅示警）。
    // 同時段多句「疊在同一點」才是錯（看起來會糊成一團）→ 標紅示警。
    // v4.30 起座標可逐句覆蓋，同時出現在【不同位置】是正常用法（例如角落註記＋底部對白），
    // 不能再像舊版那樣一律把第 2 句之後全染紅。
    const seen=new Set();
    const collide=cur.map(c=>{ const s=effStyle(c,trk); const k=s.posX.toFixed(2)+','+s.posY.toFixed(2);
      const dup=seen.has(k); seen.add(k); return dup; });
    cur.forEach((c,i)=>{
      const st=effStyle(c, trk);
      // 容器定位（v4.26 座標制，與 ASS \pos(x,y)＋Alignment 同構）：
      // posX/posY＝畫面百分比座標；align/valign＝錨點（文字塊的哪一側對齊該座標）→ translate 補償。
      const a = anchorPct(st);
      // text-align 作用在「行內軸」：橫書＝水平（吃 align），直書＝垂直（要吃 valign）。
      // 直書餵 align 會變成拿左右對齊去排上下 → 與 ASS 的逐列 \an(上8/中5/下2) 對不起來。
      const ta = st.vertical ? ({ top:'start', middle:'center', bottom:'end' })[st.valign||'bottom'] : st.align;
      const contStyle = `left:${st.posX}%;right:auto;top:${st.posY}%;transform:translate(${-a.x}%,${-a.y}%);text-align:${ta};padding:0;`;
      let css=styleToCss(st, ratio);
      if(st.shadow<=0) css+='text-shadow:none;';             // 蓋掉 .line class 的預設六向描邊
      if(!st.bgBox) css+='background:transparent;';
      // padding 會把文字往內推 → 與 ASS 錯位（ASS 的 BorderStyle=3 是把色塊往【外】長，文字不動）。
      // 置中對齊時左右抵銷看不出來，靠左/靠右就整塊偏移；且固定 px 不隨 ratio 縮放＝位置還會跟著視窗跑。
      // 故：無色塊＝完全不留白；有色塊＝以等量負 margin 抵銷，色塊往外長、文字位置不動。
      css+= st.bgBox ? 'padding:.15em .4em;margin:-.15em -.4em;' : 'padding:0;';
      if(collide[i]) css+='color:#ff4444;';                   // 與前一句落在同一點＝會糊在一起
      const inner = escapeHTML(c.text||'').replace(/\n/g,'<br>'); // 直書由 writing-mode 自動分列（多行=多列）
      sig+=tk+'|'+c.id+'|'+contStyle+grab+'|'+collide[i]+'|'+c.text+'|'+JSON.stringify(st)+';';
      html+=`<div class="vsub-track${grab}" data-tk="${tk}" data-cue="${c.id}"`+
        (grab?' title="拖曳＝移動這一句／頂端把手＝旋轉"':'')+` style="${contStyle}">`+
        `<span class="line" style="${css}">${inner}</span>`+
        // 旋轉把手：滑鼠移到該句才浮出（見 styles.css）。放在容器內、隨容器定位，
        // 但【不】隨文字一起轉——轉起來把手會跑掉、抓不住。
        (grab?`<i class="rot" title="拖曳＝旋轉（按住 Shift 吸附 15°）"></i>`:'')+
      `</div>`;
    });
  }
  }catch(err){ console.error('[videoSub] 渲染錯誤（保留上次畫面）:', err); return; } // 防禦②：單次出錯不清空字幕、下次重試
  if(sig===_videoSubSig) return;
  _videoSubSig=sig;
  _videoSub.innerHTML=html;
}

/* 軌道樣式改動後的統一重繪：預覽畫面／mpv 字幕／樣式面板／字幕列表的樣式摘要。
   ── 一律走這裡（v4.29.5）：這四處本來各自散在九個呼叫點，漏掉列表摘要 → 面板改了框線、
      座標，列表卻還顯示舊值（要等別的操作觸發整份重繪才會補上，看起來像「只有某些欄位會更新」）。 */
function styleChanged(){
  renderVideoSub(); refreshMpvSubs(); renderTrackStyle(); refreshStyleSummaries();
}

/* 在預覽窗裡直接擺放【單一句】字幕（v4.30）：拖字幕＝移動、拖頂端把手＝旋轉（Shift 吸附 15°）。
   ── 寫的是【該句的逐句覆蓋】(cue.style.posX/posY/angle)，不動軌道樣式：拖哪一句就只有那句跑，
      其餘不受影響（列表標 ✱ 自訂）。整軌的標準位置仍用面板的 X／Y。
   ── 換算基準是畫面實際顯示區 _stageRect()（非 videoWrap）：不同比例的片拖起來才等效。
   ── 旋轉支點取【錨點】而非方塊中心，與 ASS 的 \frz 繞 \org(=\pos) 同構（見 substyle.originOf）。 */
let _subDrag = null;
function _subDragMove(e){
  const d = _subDrag; if(!d) return;
  const cue = d.cue; if(!cue) return;
  cue.style = cue.style || {};
  if(d.rot){
    let ang = d.angle + (Math.atan2(e.clientY-d.py, e.clientX-d.px)*180/Math.PI - d.a0);
    if(e.shiftKey) ang = Math.round(ang/15)*15;
    cue.style.angle = Math.round(((ang+180)%360+360)%360-180); // 收斂到 -180~180＝面板欄位範圍
  }else{
    cue.style.posX = clamp(d.posX + (e.clientX-d.x0)/d.rect.w*100, 0, 100);
    cue.style.posY = clamp(d.posY + (e.clientY-d.y0)/d.rect.h*100, 0, 100);
  }
  // 拖曳中只重繪預覽；mpv 與列表摘要留到放開才做
  // （每次移動重送 ASS／重寫上千列摘要都太貴）
  renderVideoSub();
  e.preventDefault();
}
function _subDragEnd(e){
  const d = _subDrag; if(!d) return;
  _subDrag = null;
  _videoSub.classList.remove('dragging');
  try{ _videoSub.releasePointerCapture(e.pointerId); }catch(err){}
  refreshMpvSubs(); refreshStyleSummaries(); drawTimeline(); // 座標／角度變了 → 摘要與 ✱ 標記要跟上
  recordHistory((d.rot ? '旋轉字幕' : '移動字幕位置')+cueSuffix(d.cue)); // 一次拖曳＝一個還原點
}
_videoSub?.addEventListener('pointerdown', e => {
  if(e.button !== 0) return;
  const el = e.target.closest?.('.vsub-track.drag'); if(!el) return;
  const trk = State.tracks[+el.dataset.tk];
  const cue = State.cues.find(c => c.id === el.dataset.cue);
  const rect = _stageRect();
  if(!trk || !cue || trk.locked || !rect?.w || !rect?.h) return;
  const st = effStyle(cue, trk), box = el.getBoundingClientRect();
  const a = anchorPct(st);
  // 旋轉支點＝錨點在畫面上的實際位置（與 CSS transform-origin／ASS \org 同一點），
  // 不是方塊中心——支點取錯，把手轉起來文字會用另一個圓心跑掉。
  const px = box.left + box.width*a.x/100, py = box.top + box.height*a.y/100;
  _subDrag = { cue, rect, rot: !!e.target.closest('.rot'), x0: e.clientX, y0: e.clientY,
    posX: st.posX, posY: st.posY, angle: st.angle||0, px, py,
    a0: Math.atan2(e.clientY-py, e.clientX-px)*180/Math.PI };
  // 捕獲掛在圖層上：.vsub-track 每次重繪都被換掉，捕在它身上會當場斷線
  try{ _videoSub.setPointerCapture(e.pointerId); }catch(err){}
  _videoSub.classList.add('dragging');
  e.preventDefault();
});
_videoSub?.addEventListener('pointermove', _subDragMove);
_videoSub?.addEventListener('pointerup', _subDragEnd);
_videoSub?.addEventListener('pointercancel', _subDragEnd);

/* ===== 快取管理對話框（桌面版） ===== */
function _fmtBytes(n){ n=+n||0; if(n<1024)return n+' B'; const u=['KB','MB','GB','TB']; let i=-1; do{n/=1024;i++;}while(n>=1024&&i<u.length-1); return n.toFixed(n<10?1:0)+' '+u[i]; }
let _cacheDlgGen=0;
async function openCacheDialog(){
  const DESK=window.subtool;
  if(!DESK||!DESK.cacheInfo){ showToast('快取管理僅在桌面版可用'); return; }
  const myGen=++_cacheDlgGen;
  openModal('🗂 轉檔快取','<div style="padding:6px 2px">讀取中…</div>',[{label:'關閉',primary:true,act:closeModal}]);
  let info; try{ info=await DESK.cacheInfo(); }catch(e){ info={folders:0,bytes:0,root:''}; }
  // 使用者在讀取期間已關閉（或又開了別的對話框）就不要把對話框彈回來
  if(myGen!==_cacheDlgGen || !$('modalBg').classList.contains('show')) return;
  const html=
    `<div style="padding:4px 2px;line-height:1.9">`+
    `<div>中央快取：<b>${info.folders}</b> 個項目，共 <b>${_fmtBytes(info.bytes)}</b></div>`+
    `<div style="font-size:11px;color:var(--muted);word-break:break-all;margin-top:2px">${escapeHTML(info.root||'')}</div>`+
    `<div style="font-size:12px;color:var(--muted);margin-top:8px">說明：開啟影片時會把每個聲道與波形轉存到「影片同資料夾的 <code>.subtool_Cache</code>」內，其他電腦讀取同一個檔案時可直接沿用、不必重算。此處管理的是本機的中央快取。</div>`+
    `</div>`;
  const buttons=[
    {label:'清理孤兒檔',act:async()=>{ const r=await DESK.cacheCleanOrphans(); showToast(`已清理 ${r.removed} 個無效項目，釋放 ${_fmtBytes(r.bytes)}`); openCacheDialog(); }},
    {label:'全部清除',act:()=>{
      openModal('確認清除','<div style="padding:6px 2px">將刪除所有中央快取，以及目前開啟影片旁的 .subtool_Cache 資料夾。<br>下次開啟同檔需重新轉檔。確定？</div>',
        [{label:'確定清除',primary:true,act:async()=>{ const r=await DESK.cacheClearAll(State.mediaPath||null); showToast(`已清除快取，釋放 ${_fmtBytes(r.bytes)}`); closeModal(); }},{label:'取消',act:openCacheDialog}]);
    }},
    {label:'關閉',primary:true,act:closeModal},
  ];
  openModal('🗂 轉檔快取',html,buttons);
}
function onDurationKnown(){
  $('tcDur').textContent=secToEncore(State.duration,State.fps,State.dropFrame);
  $('seekBar').max=Math.max(1,Math.round(State.duration*1000));
  $('stMedia').textContent=State.mediaName?(State.mediaName+(State.mediaSize?(' · '+(State.mediaSize/1e6).toFixed(1)+'MB'):'')):'';
  const vw=viewportW();
  if(vw && State.duration>0){
    const minPps = (vw-40)/State.duration;
    $('zoomBar').min = Math.min(10, minPps).toFixed(3);
  }
  if(_firstLoad && State.duration>0){ zoomFitVideo(); _firstLoad=false; }
  else if(State.pxPerSec*State.duration < vw) zoomFitVideo();
  else drawTimeline();
}
function ensurePlayheadVisible(){
  const t=Media.displayTime();
  const vw=viewportW();
  if(!vw) return;
  const x=timeToX(t);
  if(x<40 || x>vw-40){
    const newLeft=Math.max(0, t*State.pxPerSec - vw*0.3);
    tlScroll.scrollLeft=newLeft;
    State.viewStart=tlScroll.scrollLeft/State.pxPerSec; // read back actual (browser may clamp)
    drawRuler(); drawWave(); renderCueBlocks(); updatePlayhead(); // sync immediately; don't wait for passive scroll event
  }
}

/* 影片事件 */
video.addEventListener('timeupdate',()=>{
  // FPS-SYNC（詳見 FPS_時碼一致性.md）：tcCur/seekBar/播放點都以 displayTime() 為唯一來源
  let t = Media.displayTime();
  $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame); // 時:分:秒:格
  $('seekBar').value=Math.round(t*1000);
  if(!Media.playing) updatePlayhead();
});
let rafOn=false, rafFrame=0, _rafLastIdx=0;
function rafLoop(){
  if(Media.playing){
    Media.seqTick(); // 影片序列：段尾切換 / 間隙進出 / 序列結尾停止
    const t=Media.displayTime();
    // 無媒體時更新時間顯示；序列間隙中影片暫停無 timeupdate，也由此更新
    if(!video.src || Media._gap){
      $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
      $('seekBar').value=Math.round(t*1000);
    }
    ensurePlayheadVisible(); // scroll viewport first so State.viewStart is current
    updatePlayhead(); renderVideoSub();
    if(Wave.live){ Wave.captureLive(); if((rafFrame++ % 6)===0) drawWave(); }
    // active 字幕（快取游標，O(1) 命中常見路徑）
    const _t=t+0.001;
    let act=null;
    if(_rafLastIdx>=0 && _rafLastIdx<State.cues.length){
      const lc=State.cues[_rafLastIdx];
      if(lc.timed!==false && _t>=lc.start && _t<=lc.end) act=lc;
    }
    if(!act){
      // 檢查相鄰 ±2 條
      const lo=Math.max(0,_rafLastIdx-2), hi=Math.min(State.cues.length-1,_rafLastIdx+2);
      for(let i=lo;i<=hi;i++){
        const c=State.cues[i]; if(c && c.timed!==false && _t>=c.start && _t<=c.end){ act=c; _rafLastIdx=i; break; }
      }
    }
    if(!act){
      // 完整搜尋（僅在跳轉等情境觸發）
      for(let i=0;i<State.cues.length;i++){
        const c=State.cues[i]; if(c.timed!==false && _t>=c.start && _t<=c.end){ act=c; _rafLastIdx=i; break; }
      }
    }
    if(act&&act.id!==State.activeId){ State.activeId=act.id; markActiveRow(act.id); }

    // 自動選取邏輯
    if(State.autoSelect) {
      const tk = State.listTrack || 0;
      if (act && (act.track || 0) === tk && act.id !== State.selectedId) {
        const editing = document.activeElement && document.activeElement.classList.contains('txt') && document.activeElement.contentEditable === 'true';
        if (!editing) {
          selectCueSingle(act.id, false);
        }
      }
    }

    // active 備註
    if(State.notes.length&&$('notesPanel').classList.contains('show')) updateNoteActive(t);
    // buffer 音軌 drift 校正（序列間隙中不校正——影片已暫停，重啟音源會誤出聲）
    if(Media.ctx && !Media._gap && Media.tracks.some(t=>t.kind==='buffer'&&!t._srcHidden)){
      const expect=Media.startMediaTime+(Media.ctx.currentTime-Media.startCtxTime)*(video.playbackRate||1);
      if(Math.abs(expect-video.currentTime)>0.25){ Media.stopBufferSources(); Media.startBufferSources(video.currentTime); }
    }
    // element 音軌 drift 校正（多軌同步）：ext-* 參考音對「時間軸時間」；clip 綁定音軌對【各自音源】的來源時間
    // （疊合時各段 offset 不同，不能一律用 active clip 的 vTime，否則下層/主影片音軌會被拉到上層的來源時間）
    for(const tr of Media.tracks){ if(tr.kind==='element'&&tr.el&&!tr.el.paused){
      const s=tr.source||'';
      let ref;
      if(s.startsWith('ext-')) ref=Media.tlTime();
      else if(Media.seqOn()){ const lt=Media._srcLocalT(s||'video', Media.tlTime()); if(lt==null) continue; ref=lt; }
      else ref=Media.vTime();
      if(Math.abs(tr.el.currentTime - ref) > 0.12){ try{tr.el.currentTime=ref;}catch(e){} }
    }}
  }
  try{ WCPreview.tick(); }catch(e){} // WebCodecs 預覽畫面（每幀；未就緒/失敗自動 fallback 畫 video）
  try{ Media.applyPreviewFade(); }catch(e){} // 預覽淡出入黑提示（每幀；WC 真合成時被抑制——tick 先設旗標）
  updateMeters();
  requestAnimationFrame(rafLoop);
}
function markActiveRow(id){
  sublist.querySelectorAll('.sub-row.active').forEach(r=>r.classList.remove('active'));
  if (State.subMode) return;
  
  const row=sublist.querySelector(`.sub-row[data-id="${id}"]`);
  if(row){
    row.classList.add('active');
    row.scrollIntoView({block:'nearest'});
  }
}
video.addEventListener('play',()=>{
  Media.playing=true;
  $('playBtn').textContent='⏸';
  // 播放中不要取消目前選擇的字幕
});
video.addEventListener('pause',()=>{
  $('playBtn').textContent='▶';
  const t=Media.displayTime();
  $('tcCur').textContent=secToEncore(t,State.fps,State.dropFrame);
  $('seekBar').value=Math.round(t*1000);
  updatePlayhead();
  
  if (!State.subMode && State.selectedId) {
    const c = State.cues.find(x => x.id === State.selectedId);
    if (c) {
      const tkCues = State.cues.filter(x => (x.track || 0) === (c.track || 0));
      const idx = tkCues.findIndex(x => x.id === c.id);
      const nextCue = idx >= 0 && idx < tkCues.length - 1 ? tkCues[idx + 1] : null;
      const targetOut = nextCue ? nextCue.end : c.end;
      if (t > targetOut) {
        State.selectedIds=[];
        State.selectedId=null;
        refreshSelectionUI();
        const stSel = $('stSel');
        if(stSel) stSel.textContent='';
      }
    }
  }
});
video.addEventListener('seeked',()=>{updatePlayhead();renderVideoSub();updateNoteActive(video.currentTime);});
window.addEventListener('mpv:seeked',e=>{updatePlayhead();renderVideoSub();updateNoteActive(e.detail);});
video.addEventListener('ended',()=>{ if(Media.seqContinueAtEnd()) return; Media.pause(); }); // 序列有後續→推進不暫停

/* 影片視窗與時間碼 滾輪逐格播放 */
['videoWrap', 'tcCur'].forEach(id => {
  $(id)?.addEventListener('wheel', e => {
    e.preventDefault();
    const frames = e.deltaY > 0 ? 1 : -1;
    nudge(frames / getExactFps(State.fps || 30));
  }, {passive: false});
});

/* seek bar */
$('seekBar').addEventListener('input',e=>{ const t=(+e.target.value)/1000; Media.seek(t); updateNoteActive(t); });
// rateSel removed from UI — speed controlled via JKL keys
$('fpsSel').addEventListener('change',e=>{
  const prev=State.fps,prevDf=State.dropFrame;
  setFps(e.target.value);
  State.cues.forEach(c => {
    c.start = snapTimeToFrame(c.start, State.fps, State.dropFrame);
    c.end = snapTimeToFrame(c.end, State.fps, State.dropFrame);
  });
  State.notes.forEach(n => {
    n.time = snapTimeToFrame(n.time, State.fps, State.dropFrame);
  });
  renderAll();
  renderNotes();
  Media.seek(Media.displayTime());
  drawTimeline();
  recordHistory(`切換 FPS ${prevDf?prev+'df':prev}→${State.fps+(State.dropFrame?'df':'')}`);
  e.target.blur();
});
$('zoomBar').addEventListener('input',e=>setZoom(+e.target.value));




// A4：純關閉面板的 case 改用資料表，消除重複的 classList.remove('show')+_syncMpvPanel()
const CLOSE_PANELS = { 'close-shift':'shiftPanel', 'close-history':'historyPanel', 'close-notes':'notesPanel', 'close-mixer':'mixerPanel' };
async function doAction(act, force = false){
  if(CLOSE_PANELS[act]){ $(CLOSE_PANELS[act]).classList.remove('show'); _syncMpvPanel(); return; }
  switch(act){
    case 'open-media':
      // 已有影片時 openIncoming 會詢問「加入序列」或「取代」
      if(IS_DESKTOP){ const p=await DESK.openMedia(); if(p)Media.openIncoming({path:p}); }
      else { const f=await pickFile($('fileMedia')); if(f)Media.openIncoming({file:f}); } break;
    case 'add-audio':
      if(IS_DESKTOP){ const ps=await DESK.openAudio(); for(const p of (ps||[]))await Media.addAudioFileDesktop(p); }
      else { const f=await pickFile($('fileAudio')); if(f)Media.addAudioFile(f); } break;
    case 'open-project':
      if(IS_DESKTOP){ const r=await DESK.openProject(); if(r)Project.loadDesktop(r); }
      else { const f=await pickFile($('fileProject')); if(f)Project.load(f); } break;
    case 'save-project': Project.save(); break;
    case 'save-as-project': Project.saveAs(); break;
    case 'new':
      // Fix #15 同款：破壞性動作改用 openModal，風格一致且 Electron 不會截取原生 confirm
      openModal('開新專案',
        '<p>確定清空目前專案？字幕、備註與已載入的影音都將清除（未存檔的話）。</p>',
        [{label:'取消',act:closeModal},
         {label:'確定清空',primary:true,act:()=>{
           closeModal();
           State.cues=[];State.notes=[];State.selectedId=null;State.selectedIds=[];
           State.listTrack=0;State.tracks=[];ensureTrackCount(0);
           if(State.subMode) doAction('sub-mode');
           History.reset();resetProject();_firstLoad=true;
           // 清除影音
           video.pause(); video.removeAttribute('src'); video.load();
           State.mediaName=''; State.mediaPath=''; State.mediaSize=0;
           Media.reset();
           const nv=$('noVideo'); if(nv) nv.style.display='';
           onDurationKnown(); renderAudioTracks();
           renderListTrackSel();renderAll();renderNotes();drawTimeline();
           setStatus('新專案','ok');
         }}]);
      break;
    case 'imp-auto': importSub(); break;
    case 'exp-dialog': showExportDialog(); break;
    case 'exp-video': showExportVideoDialog(); break;
    case 'split-clip': Media.splitClipAt(Media.displayTime()); break; // 同 Ctrl+K：在播放點切割影片段
    case 'exp-srt': exportSub('srt'); break;
    case 'exp-ass': exportSub('ass'); break;
    case 'exp-encore': exportSub('encore'); break;
    case 'exp-txt': exportSub('txt'); break;
    case 'fps-convert': showFpsConvertDialog(); break;
    case 'shift-tc': togglePanel('shiftPanel'); break;
    case 'shift-back': applyTcShift(-1); break;
    case 'shift-fwd': applyTcShift(1); break;
    case 'dur-adj-sub': applyDurAdjTc(-1); break;
    case 'dur-adj-add': applyDurAdjTc(1); break;
    case 'dur-adj-pct': applyDurAdjPct(); break;
    case 'sub-mode':
      State.subMode=!State.subMode;
      { const smb=$('subModeBtn'); if(smb)smb.classList.toggle('sub-active',State.subMode); }
      document.body.classList.toggle('sub-mode-on', State.subMode);
      if(State.subMode){ 
        State._prevAutoSelect = State.autoSelect;
        State._prevOverwriteMode = State.overwriteMode;
        State._prevOverwriteKeep = State.overwriteKeep;
        if (State.autoSelect) doAction('toggle-auto-select', true);
        if (State.overwriteMode) doAction('toggle-overwrite', true);
        if (!State.overwriteKeep) doAction('toggle-ow-keep', true);
        
        // 擷取當時的完整字幕 ID 順序
        State._subModeSequence = State.cues.map(c => c.id);
        // 追蹤 subMode 期間被 I 鍵設定的字幕 ID（退出時作為安全網清理依據）
        State._subModeTouchedIds = new Set();

        setStatus('🎯 上字幕模式 ON — I 設起點，O 設終點後自動前進','ok');
      }
      else { 
        if (State._prevAutoSelect !== undefined && State.autoSelect !== State._prevAutoSelect) {
           doAction('toggle-auto-select', true);
        }
        if (State._prevOverwriteMode !== undefined && State.overwriteMode !== State._prevOverwriteMode) {
           doAction('toggle-overwrite', true);
        }
        if (State._prevOverwriteKeep !== undefined && State.overwriteKeep !== State._prevOverwriteKeep) {
           doAction('toggle-ow-keep', true);
        }
        
        // 清理殘留的未閉合超長字幕
        let changed = false;
        // 第一層：清理帶有 _tempEnd 標記的字幕
        State.cues.forEach(cue => {
          if (cue._tempEnd) {
            cue.end = Math.min(cue.start + 2.0, (State.duration || Infinity));
            delete cue._tempEnd;
            changed = true;
          }
        });
        // 第二層安全網：檢查所有在 subMode 期間被 I 鍵觸碰過的字幕
        // 即使 _tempEnd 已被意外清除，若 end 仍然異常長（>10 分鐘），也修正回來
        if (State._subModeTouchedIds && State._subModeTouchedIds.size > 0) {
          const maxReasonableDur = 600; // 10 分鐘，超過視為異常
          State.cues.forEach(cue => {
            if (State._subModeTouchedIds.has(cue.id)) {
              const dur = cue.end - cue.start;
              if (dur > maxReasonableDur) {
                cue.end = Math.min(cue.start + 2.0, (State.duration || Infinity));
                changed = true;
              }
            }
          });
          delete State._subModeTouchedIds;
        }
        // 脫離上字幕模式後強制重新排序，並觸發重繪
        sortCues();
        if (changed) {
          emit('render:videoSub'); emit('mpv:refreshSubs');
        }
        emit('render:all');

        Media.pause(); setStatus('上字幕模式 OFF',''); 
      }
      break;
    case 'playpause':
      resetPlaybackSpeed(); // 重置 JKL 穿梭速度回 1x（清掉殘留的倍率）
      Media.toggle();
      setStatus(Media.playing?'▶ 正播':'⏸ 暫停', Media.playing?'ok':''); // 狀態列同步播放/暫停（非僅 JKL）
      break;
    case 'seek-start': Media.seek(0); break;
    case 'back5': nudge(-5); break;
    case 'back1': nudge(-1); break;
    case 'fwd1': nudge(1); break;
    case 'fwd5': nudge(5); break;
    case 'frame-back': nudge(-1/State.fps); break;
    case 'frame-fwd': nudge(1/State.fps); break;
    case 'set-in': setIn(); break;
    case 'set-out': setOut(); break;
    case 'add-cue': addCueRelative(1); break;
    case 'add-cue-above': addCueRelative(-1); break;
    case 'add-cue-below': addCueRelative(1); break;
    case 'del-cue': deleteSelected(); break;
    case 'add-track': addTrack(); break;
    case 'zoom-in': setZoom(State.pxPerSec*1.3); break;
    case 'zoom-out': setZoom(State.pxPerSec*0.77); break;
    case 'zoom-fit': 
      if(window._lastZoomMode === 'fit') { zoomFitVideo(); window._lastZoomMode = 'video'; }
      else { zoomFit(); window._lastZoomMode = 'fit'; }
      break;
    case 'undo': History.undo(); break;
    case 'redo': History.redo(); break;
    case 'history': togglePanel('historyPanel'); renderHistory(); break;
    case 'notes': togglePanel('notesPanel'); renderNotes(); break;
    case 'add-note': addNote(); break;
    case 'clear-notes': clearAllNotes(); break;
    case 'mixer': togglePanel('mixerPanel'); renderMixer(); break;
    case 'mixer-reset': mixerReset(); break;
    case 'mixer-muteall': mixerMuteAll(); break;
    case 'cache-manage': openCacheDialog(); break;
    case 'export-notes': exportNotes(); break;
    case 'toggle-all-vis': { const anyVis=State.tracks.some(t=>t.visible!==false); State.tracks.forEach(t=>t.visible=!anyVis); drawTimeline(); renderVideoSub(); refreshMpvSubs(); } break;
    case 'toggle-all-lock': { const anyUnlocked=State.tracks.some(t=>!t.locked); State.tracks.forEach(t=>t.locked=anyUnlocked); drawTimeline(); } break;
    case 'copy-track': doCopyTrack(); break;
    case 'check-panel': { const btn=$('checkPanelBtn'); const willShow=!$('checkPanel').classList.contains('show'); togglePanel('checkPanel'); if(btn)btn.classList.toggle('sub-active',willShow); if(willShow)renderCheckPanel(); } break;
    case 'close-check': { $('checkPanel').classList.remove('show'); const btn=$('checkPanelBtn'); if(btn)btn.classList.remove('sub-active'); _syncMpvPanel(); } break;
    case 'search-open': { const sd=$('searchDialog'); if(sd){ const show=sd.style.display==='none'||!sd.style.display; sd.style.display=show?'flex':'none'; if(show)setTimeout(()=>$('searchInput')?.focus(),20); _syncMpvPanel(); } } break;
    case 'search-close': { const sd=$('searchDialog'); if(sd){ sd.style.display='none'; _syncMpvPanel(); } } break;
    case 'search-next': searchNav(1); break;
    case 'search-prev': searchNav(-1); break;
    case 'search-clear': { $('searchInput').value=''; searchUpdate(); $('searchInput').focus(); } break;
    case 'search-select-all': searchSelectAll(); break;
    case 'replace-one': searchReplace(false); break;
    case 'replace-all': searchReplace(true); break;
    case 'trim-track': trimTrackSpaces(); break;
    case 'remove-srt-tags': {
      let changed = false;
      State.cues.forEach(c => {
        if (c.text) {
          const nt = c.text.replace(/<[^>]+>|\{\\[^}]+\}/g, '');
          if (nt !== c.text) { c.text = nt; changed = true; }
        }
      });
      if (changed) { recordHistory('清除 SRT 標籤'); emit('render:all'); setStatus('已清除所有標籤', 'ok'); }
      else { setStatus('未發現可清除的標籤', ''); }
    } break;
    case 'settings': showSettingsModal(); break;
    case 'modal-close': closeModal(); break;
    case 'toggle-auto-select':
      if (State.subMode && !force) { setStatus('上字幕模式中強制關閉自動選取', 'err'); break; }
      State.autoSelect = !State.autoSelect;
      const asBtns = document.querySelectorAll('.auto-select-btn');
      asBtns.forEach(btn => {
        btn.textContent = State.autoSelect ? '自動選取' : '不自動選取';
        btn.classList.toggle('on', State.autoSelect);
      });
      setStatus(`播放時自動選取：${State.autoSelect ? '開' : '關'}`, 'ok');
      saveConfig();
      break;
    case 'toggle-overwrite':
      if (State.subMode && !force) { setStatus('上字幕模式中強制鎖定不可覆蓋', 'err'); break; }
      State.overwriteMode = !State.overwriteMode;
      const owBtns = document.querySelectorAll('.ow-toggle-btn');
      owBtns.forEach(btn => {
      btn.textContent = State.overwriteMode ? '🔓 可覆蓋' : '🔒 不覆蓋';
      btn.classList.toggle('primary', State.overwriteMode);
    });
    document.querySelectorAll('.ow-keep-btn').forEach(btn => {
      btn.classList.toggle('inactive-mode', !State.overwriteMode);
    });
      setStatus(`覆蓋模式：${State.overwriteMode ? '解鎖 (可自由重疊)' : '鎖定 (不可覆蓋)'}`, 'ok');
      saveConfig();
      break;
    case 'toggle-ow-keep':
      if (State.subMode && !force) { setStatus('上字幕模式中強制鎖定保留', 'err'); break; }
      State.overwriteKeep = !State.overwriteKeep;
      document.querySelectorAll('.ow-keep-btn').forEach(btn => {
        btn.textContent = State.overwriteKeep ? '⚪ 保留' : '❌ 刪除';
        btn.classList.toggle('del', !State.overwriteKeep);
      });
      setStatus(`完全覆蓋時：${State.overwriteKeep ? '保留' : '刪除'} 被包含的字幕`, 'ok');
      saveConfig();
      break;
  }
}
let _repTimer=null, _repInterval=null, _repFired=false;
const REP_ACTS=['back5','back1','frame-back','frame-fwd','fwd1','fwd5'];
document.addEventListener('mousedown',e=>{
  if(e.button!==0)return;
  const b=e.target.closest('[data-act]');
  if(b && REP_ACTS.includes(b.dataset.act)){
    _repFired=false;
    _repTimer=setTimeout(()=>{
      _repInterval=setInterval(()=>{ doAction(b.dataset.act); _repFired=true; }, 100);
    }, 400);
  }
});
const stopRep=()=>{ clearTimeout(_repTimer); clearInterval(_repInterval); };
document.addEventListener('mouseup', stopRep);
document.addEventListener('mouseout', e=>{ if(e.target.closest&&e.target.closest('[data-act]'))stopRep(); });

document.addEventListener('click',e=>{
  const b=e.target.closest('[data-act]');
  if(b){
    b.blur();
    if(_repFired && REP_ACTS.includes(b.dataset.act)){ _repFired=false; return; }
    doAction(b.dataset.act);
  }
  // 關閉下拉選單
  document.querySelectorAll('.menu.open').forEach(m=>{ if(!m.contains(e.target))m.classList.remove('open'); });
});
document.querySelectorAll('.menu>button').forEach(btn=>{
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    const m=btn.parentElement; const wasOpen=m.classList.contains('open');
    document.querySelectorAll('.menu.open').forEach(x=>x.classList.remove('open'));
    if(!wasOpen)m.classList.add('open');
  });
});
// 選單項目點擊後關閉
document.querySelectorAll('.menu .items button').forEach(b=>b.addEventListener('click',()=>{
  b.closest('.menu').classList.remove('open');
}));


/* ===== 字幕列表：軌道切換下拉 + 樣式面板 ===== */
function renderListTrackSel(){
  const sel=$('listTrackSel'); if(!sel)return;
  const prev=clamp(State.listTrack,0,State.tracks.length-1);
  State.listTrack=prev;
  sel.innerHTML=State.tracks.map((t,i)=>`<option value="${i}">${escapeHTML(t.name)}</option>`).join('');
  sel.value=String(prev);
  renderTrackStyle();
}
function renderTrackStyle(){
  const panel=$('trackStyle'); const i=State.listTrack;
  if(!State.tracks[i]){ panel.classList.add('disabled'); $('tsTitle').textContent='軌道樣式'; return; }
  panel.classList.remove('disabled');
  const tk=State.tracks[i];
  $('tsTitle').textContent='「'+tk.name+'」樣式';
  const st=effStyle(null, tk); // 生效值（缺欄位以預設後援）
  const setV=(id,v)=>{ const el=$(id); if(el&&document.activeElement!==el) el.value=v; };
  setV('tsSize',st.fontSize); setV('tsColor',(st.color||'#ffffff').toLowerCase());
  { const p=posToPx(st); setV('tsPosX',p.x); setV('tsPosY',p.y); } // 座標以像素呈現（內部為百分比）
  setV('tsAngle',st.angle);
  setV('tsOutline',st.outline); setV('tsOutlineColor',st.outlineColor); setV('tsShadow',st.shadow);
  setV('tsSpacing',st.letterSpacing); setV('tsLineSp',st.lineSpacing);
  setV('tsBgColor',st.bgColor); setV('tsBgAlpha',Math.round(st.bgAlpha*100));
  // 字型：不在清單的（自訂）動態補一個 option
  const fsel=$('tsFont');
  if(fsel){ if(![...fsel.options].some(o=>o.value===st.font||o.text===st.font)){
      const o=document.createElement('option'); o.text=st.font; o.value=st.font; fsel.insertBefore(o, fsel.querySelector('[value="__custom"]')); }
    if(document.activeElement!==fsel) fsel.value=st.font; }
  $('tsBold')?.classList.toggle('active',!!st.bold); $('tsItalic')?.classList.toggle('active',!!st.italic);
  $('tsVertical')?.classList.toggle('active',!!st.vertical); $('tsBgBox')?.classList.toggle('active',!!st.bgBox);
  panel.querySelectorAll('.ts-preset[data-ts-size]').forEach(b=>b.classList.toggle('active',+b.dataset.tsSize===st.fontSize));
  panel.querySelectorAll('.ts-preset[data-ts-valign]').forEach(b=>b.classList.toggle('active',b.dataset.tsValign===(st.valign||'bottom')));
  panel.querySelectorAll('.ts-preset[data-ts-align]').forEach(b=>b.classList.toggle('active',b.dataset.tsAlign===(st.align||'center')));
  // 底色未啟用時把色框/透明度變暗（消除「改了 bgColor 卻沒反應」的困惑——需先按「底」）
  const bgOn=!!st.bgBox; ['tsBgColor','tsBgAlpha'].forEach(id=>{ const el=$(id); if(el){ el.style.opacity=bgOn?'1':'.4'; el.title=(el.title||'').replace(/（未啟用.*$/,'')+(bgOn?'':'（未啟用：先按「底」）'); } });
  panel.querySelectorAll('.ts-clr').forEach(b=>b.classList.toggle('active',b.dataset.color===(st.color||'').toLowerCase()));
  // 常用樣式下拉重建
  const psel=$('tsPresetSel');
  if(psel){ const cur=psel.value; psel.innerHTML='<option value="">— 套用 —</option>'+getPresets().map(p=>`<option>${escapeHTML(p.name)}</option>`).join(''); psel.value=cur||''; }
}

/* ===== 時間軸：雙擊字幕區塊內嵌編輯文字 ===== */
async function startInlineEdit(block,c){
  await ensureProjectSaved();
  hideCtx();
  const ed=document.createElement('textarea'); ed.className='cue-inline-edit'; ed.value=c.text||'';
  const r=block.getBoundingClientRect(), lr=tlLayer.getBoundingClientRect();
  ed.style.left=(r.left-lr.left)+'px'; ed.style.top=(r.top-lr.top)+'px';
  ed.style.width=Math.max(90,r.width)+'px'; ed.style.minHeight=r.height+'px';
  tlLayer.appendChild(ed); ed.focus(); ed.select();
  let done=false; const orig=c.text||'';
  const commit=(save)=>{ if(done)return; done=true; if(save)c.text=ed.value; ed.remove(); renderAll(); renderVideoSub(); if(save&&(c.text||'')!==orig)recordHistory('編輯字幕文字'+cueSuffix(c)); };
  ed.addEventListener('keydown',ev=>{ ev.stopPropagation();
    if(ev.key==='Enter'&&!ev.shiftKey){ ev.preventDefault(); commit(true); }
    else if(ev.key==='Escape'){ ev.preventDefault(); commit(false); } });
  ed.addEventListener('blur',()=>commit(true));
  ed.addEventListener('mousedown',ev=>ev.stopPropagation());
  ed.addEventListener('dblclick',ev=>ev.stopPropagation());
}

let _covCleared=false; // 本次開窗有沒有按過「清除全部覆蓋」（決定要不要連座標／角度一起清）
async function openCueEditModal(c){
  await ensureProjectSaved();
  _covCleared=false;
  const orig=c.text||'';
  const trackIdx=c.track||0;
  const trackName=State.tracks[trackIdx]?.name||'';
  const tc=`${secToEncore(c.start,State.fps,State.dropFrame)} → ${secToEncore(c.end,State.fps,State.dropFrame)}`;

  // 找同 in 點的其他軌道字幕（容差 1 格）
  const TOL=1/Math.max(State.fps||25,1);
  const siblings=[];
  State.tracks.forEach((tk,i)=>{
    if(i===trackIdx)return;
    const match=State.cues.find(oc=>(oc.track||0)===i&&Math.abs(oc.start-c.start)<=TOL);
    if(match)siblings.push({trackName:tk.name,text:match.text||'',tkIdx:i});
  });

  const mkBlock=(label,text,btnId)=>
    `<div style="margin-bottom:12px">`+
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">`+
        `<span style="font-size:12px;color:var(--text-faint)">${label}</span>`+
        `<button id="${escapeHTML(btnId)}" style="font-size:11px;padding:1px 7px">複製</button>`+
      `</div>`+
      `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:8px 10px;min-height:2.2em">`+
        `<div id="${btnId==='cueEditCopy'?'cueEditOrig':''}" style="white-space:pre-wrap;font-size:14px;font-family:inherit;color:var(--text);user-select:text;cursor:text">${escapeHTML(text).replace(/\n/g, '<br>')}</div>`+
      `</div>`+
    `</div>`;

  const sibHtml=siblings.map(s=>mkBlock('軌道：'+s.trackName,s.text,'cueEditCopySib'+s.tkIdx)).join('');

  // v4.23 逐句樣式覆蓋：欄位定義（key, 標籤, 類型）——bool 用 select(開/關)、其餘勾選＋輸入
  const COV_FIELDS=[
    ['color','顏色','color'],['fontSize','字級','num'],['bold','粗體','bool'],['italic','斜體','bool'],
    ['outline','框線','num'],['outlineColor','框線色','color'],['shadow','陰影','num'],
    ['letterSpacing','字距','num'],['lineSpacing','行距','num'],['font','字型','text'],['vertical','直書','bool'],
  ];
  const effNow=effStyle(c, State.tracks[trackIdx]||null);
  const covRow=([k,label,type])=>{
    const has=!!(c.style&&c.style[k]!=null);
    const v=has?c.style[k]:effNow[k];
    let inp;
    if(type==='color') inp=`<input type="color" id="covV_${k}" value="${v}" style="width:26px;height:20px;padding:0">`;
    else if(type==='num') inp=`<input type="number" id="covV_${k}" value="${v}" step="${k==='lineSpacing'?0.1:0.5}" style="width:56px">`;
    else if(type==='bool') inp=`<select id="covV_${k}"><option value="1"${v?' selected':''}>開</option><option value="0"${!v?' selected':''}>關</option></select>`;
    else inp=`<input type="text" id="covV_${k}" value="${escapeHTML(String(v))}" style="width:90px">`;
    return `<label style="display:flex;align-items:center;gap:4px;white-space:nowrap"><input type="checkbox" id="covK_${k}"${has?' checked':''}>${label}</label>${inp}`;
  };
  const covHtml=
    `<details id="cueStyleOv"${c.style?' open':''} style="margin-top:10px;border:1px solid var(--border);border-radius:4px;padding:6px 8px">`+
    `<summary style="cursor:pointer;font-size:12px;color:var(--text-faint)">✱ 樣式覆蓋（僅此句；未勾選＝繼承軌道樣式）</summary>`+
    `<div style="display:grid;grid-template-columns:auto auto auto auto;gap:8px 14px;padding:10px 2px 4px;font-size:12px;align-items:center">`+
    COV_FIELDS.map(covRow).join('')+
    `</div><button id="covClear" style="font-size:11px;margin-top:6px">清除全部覆蓋</button></details>`;
  const doConfirm=()=>{
    const ta=$('cueEditTa');
    if(!ta) return;
    let val=ta.innerText;
    if(val.endsWith('\n') && !orig.endsWith('\n')) val=val.slice(0,-1);
    // 收集樣式覆蓋（勾選的欄位）。
    // ── 這裡是把 c.style【整個重建】，所以本視窗沒有控件的覆蓋欄位必須先原樣搬過來：
    //    座標／角度是在預覽窗拖出來的，這裡沒有對應欄位，不保留的話「開一下視窗按確定」
    //    就會把拖好的位置與角度默默清掉（angle 自 v4.27 起即有此問題）。
    //    使用者若要清掉它們，走「清除全部覆蓋」（見下方 covClear，會連同這些一起清）。
    const style={}; const origStyle=JSON.stringify(c.style||null);
    const managed=new Set(COV_FIELDS.map(f=>f[0]));
    if(c.style && !_covCleared) for(const k of CUE_STYLE_KEYS){ if(!managed.has(k) && c.style[k]!=null) style[k]=c.style[k]; }
    for(const [k,,type] of COV_FIELDS){
      const on=$('covK_'+k), vi=$('covV_'+k);
      if(!on||!on.checked||!vi) continue;
      style[k]= type==='num' ? +vi.value : type==='bool' ? (vi.value==='1') : vi.value;
    }
    if(Object.keys(style).length) c.style=style; else delete c.style;
    const styleChanged=JSON.stringify(c.style||null)!==origStyle;
    c.text=val; closeModal(); renderAll(); renderVideoSub(); if(styleChanged) refreshMpvSubs();
    if(val!==orig||styleChanged) recordHistory('編輯字幕'+(styleChanged?'（含樣式覆蓋）':'文字')+cueSuffix(c));
  };
  openModal('修改字幕文字',
    `<div style="font-size:12px;color:var(--text-faint);margin-bottom:10px">${escapeHTML(trackName)} ｜ ${tc}</div>`+
    `<div style="max-height:58vh;overflow-y:auto;padding-right:2px">`+
    sibHtml+
    mkBlock('原文',orig,'cueEditCopy')+
    `<div style="font-size:12px;color:var(--text-faint);margin-bottom:4px">修改 <span style="font-size:10px;opacity:.5">（Enter 確認 · Shift+Enter 換行）</span></div>`+
    `<div id="cueEditTa" contenteditable="true" style="width:100%;min-height:5em;border:1px solid var(--border);border-radius:4px;background:var(--bg);font-size:14px;font-family:inherit;padding:6px;box-sizing:border-box;color:var(--text);overflow-y:auto;outline:none"></div>`+
    covHtml+
    `</div>`,
    [{label:'確認',primary:true,act:doConfirm},{label:'取消',act:closeModal}]);
  setTimeout(()=>{
    const ta=$('cueEditTa');
    if(ta){
      ta.dataset.orig=orig;
      ta.innerHTML=escapeHTML(orig).replace(/\n/g, '<br>');
      ta.focus();
      try { const r = document.createRange(), s = window.getSelection(); r.selectNodeContents(ta); s.removeAllRanges(); s.addRange(r); } catch (_) {}
      
      ta.addEventListener('keydown',e=>{
      // Enter 系列一律擋住冒泡：確認/切分會同步關閉 modal，若讓事件繼續傳到 window 的
      // 快捷鍵處理器，modal 已不在、同一下 Enter 會再觸發 toggle_play_pause 造成雙重動作
      if(e.key==='Enter') e.stopPropagation();
      if(e.key==='Enter'&&e.ctrlKey){
        e.preventDefault();
        const sel=window.getSelection();
        if(!sel.rangeCount)return;
        const range=sel.getRangeAt(0).cloneRange();
        range.collapse(true);
        const MARK='\x01';
        const markerNode=document.createTextNode(MARK);
        range.insertNode(markerNode);
        let raw=ta.innerText;
        markerNode.parentNode.removeChild(markerNode);
        let markerPos=raw.indexOf(MARK);
        if(markerPos<0) markerPos=raw.length;
        let full=raw.replace(MARK,'');
        if(full.endsWith('\n')&&!orig.endsWith('\n')){
          full=full.slice(0,-1);
          if(markerPos>full.length) markerPos=full.length;
        }
        const textBefore=full.slice(0,markerPos);
        const textAfter=full.slice(markerPos);
        if (!textBefore.trim() || !textAfter.trim()) { showToast('不能在句首或句尾切分，以免產生空白字幕'); return; }
        const origEnd=c.end;
        const isTimed=c.timed!==false;
        if(isTimed){ const pt=Media.displayTime(); if(pt < c.start + 0.05 || pt > c.end - 0.05){ showToast('切分點距離起訖太近，或是超出了字幕範圍'); return; } }
        let splitTime=0;
        if(isTimed){ splitTime=Media.displayTime(); c.end=splitTime; }
        c.text=textBefore;
        const nc={id:newId(),start:isTimed?splitTime:0,end:isTimed?origEnd:0,
          text:textAfter,track:c.track||0,timed:isTimed};
        const cidx=State.cues.indexOf(c);
        if(cidx>=0)State.cues.splice(cidx+1,0,nc); else State.cues.push(nc);
        closeModal(); sortCues(); renderAll(); recordHistory('拆分字幕');
        selectCue(nc.id,{seek:false});
        setTimeout(()=>{
          const nr=sublist.querySelector(`.sub-row[data-id="${nc.id}"]`);
          if(nr)nr.dispatchEvent(new MouseEvent('dblclick',{bubbles:false,cancelable:true,view:window}));
        },30);
      } else if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doConfirm();}
    });
    }
    siblings.forEach(s=>{
      const btn=$('cueEditCopySib'+s.tkIdx);
      if(btn) btn.addEventListener('click',()=>{ navigator.clipboard.writeText(s.text).then(()=>{btn.textContent='已複製';setTimeout(()=>btn.textContent='複製',1500);}); });
    });
    const copyBtn=$('cueEditCopy');
    if(copyBtn) copyBtn.addEventListener('click',()=>{ navigator.clipboard.writeText(orig).then(()=>{copyBtn.textContent='已複製';setTimeout(()=>copyBtn.textContent='複製',1500);}); });
    // 樣式覆蓋區：清除鈕＋鍵盤事件不外洩（避免觸發全域快捷鍵）
    const ov=$('cueStyleOv');
    if(ov){
      ov.addEventListener('keydown',e=>e.stopPropagation());
      const cl=$('covClear');
      // 「清除全部覆蓋」＝連同本視窗沒有控件的座標／角度一起清（見存檔處的 _covCleared）
      if(cl) cl.addEventListener('click',e=>{ e.preventDefault(); _covCleared=true;
        ov.querySelectorAll('input[type=checkbox]').forEach(x=>x.checked=false); });
    }
  },30);
}

/* ===== UI 接線（區塊切換 / 樣式 / 分隔線 / 捲動同步 / 雙擊） ===== */
function initUI(){
  // 軌道切換下拉
  $('listTrackSel').addEventListener('change',e=>{ State.listTrack=+e.target.value; State.selectedIds=[]; State.selectedId=null; $('stSel').textContent=''; searchUpdate(); renderTrackStyle(); refreshSelectionUI(); refreshTrackGutterActive(); });
  // 混音器音源切換
  const mixerSrcSel=$('mixerSrcSel');
  if(mixerSrcSel) mixerSrcSel.addEventListener('change',e=>{ Media.switchSource(e.target.value); renderMixer(); e.target.blur(); });
  
  const waveGlobalSrcSel=$('waveGlobalSrcSel');
  if(waveGlobalSrcSel) waveGlobalSrcSel.addEventListener('change',e=>{ Media.switchSource(e.target.value); renderMixer(); e.target.blur(); });

  // 樣式控制（大小 / 位置 / 顏色）
  $('tsSize').addEventListener('input',e=>{ const i=State.listTrack; if(!State.tracks[i])return; State.tracks[i].fontSize=clamp(+e.target.value,10,300); styleChanged(); });
  $('tsSize').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} });
  // 座標＝像素（UI 以影片像素輸入；內部存百分比→換影片解析度時字幕不跑掉）
  ['tsPosX','tsPosY'].forEach(id=>{
    const isX = id==='tsPosX', key = isX ? 'posX' : 'posY';
    $(id).addEventListener('input',e=>{
      const i=State.listTrack; if(!State.tracks[i])return;
      const span = isX ? (State.videoWidth||1920) : (State.videoHeight||1080);
      State.tracks[i][key] = clamp((+e.target.value / span) * 100, 0, 100);
      styleChanged();
    });
    $(id).addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} });
  });
  $('tsColor').addEventListener('input',e=>{ const i=State.listTrack; if(!State.tracks[i])return; State.tracks[i].color=e.target.value; styleChanged(); });
  // v4.23 樣式擴充：通用 setter（寫軌道欄位 → 三路重繪）；數字/顏色/切換各自包裝
  const tsSet=(k,v)=>{ const i=State.listTrack; if(!State.tracks[i])return; State.tracks[i][k]=v; styleChanged(); };
  const tsNum=(id,k,lo,hi)=>{ const el=$(id); if(!el)return;
    el.addEventListener('input',e=>tsSet(k, clamp(+e.target.value, lo, hi)));
    el.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} }); };
  const tsToggle=(id,k)=>{ const el=$(id); if(!el)return;
    el.addEventListener('click',()=>{ const i=State.listTrack; if(!State.tracks[i])return; tsSet(k, !effStyle(null,State.tracks[i])[k]); }); };
  tsNum('tsOutline','outline',0,10); tsNum('tsShadow','shadow',0,10);
  tsNum('tsAngle','angle',-180,180); // 旋轉角度（度，順時針為正；繞文字塊中心）
  tsNum('tsSpacing','letterSpacing',0,30); tsNum('tsLineSp','lineSpacing',1,3);
  $('tsOutlineColor').addEventListener('input',e=>tsSet('outlineColor',e.target.value));
  $('tsBgColor').addEventListener('input',e=>tsSet('bgColor',e.target.value));
  $('tsBgAlpha').addEventListener('input',e=>tsSet('bgAlpha', clamp(+e.target.value,0,100)/100));
  $('tsBgAlpha').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} });
  tsToggle('tsBold','bold'); tsToggle('tsItalic','italic');
  tsToggle('tsVertical','vertical'); tsToggle('tsBgBox','bgBox');
  $('tsFont').addEventListener('change',e=>{
    if(e.target.value==='__custom'){
      const cur=effStyle(null,State.tracks[State.listTrack]||null).font;
      const name=prompt('輸入字型名稱（需已安裝於系統；匯出燒入亦用此字型）', cur);
      if(name&&name.trim()) tsSet('font', name.trim()); else renderTrackStyle();
    } else tsSet('font', e.target.value);
  });
  // 常用樣式庫：存 / 套用 / 管理（跨專案，存 config）
  $('tsPresetSave').addEventListener('click',()=>{
    const i=State.listTrack; if(!State.tracks[i])return;
    const name=prompt('常用樣式名稱', State.tracks[i].name+' 樣式'); if(!name||!name.trim())return;
    const list=[...getPresets()]; const nm=name.trim();
    const style=trackStyleSnapshot(State.tracks[i]);
    const ex=list.findIndex(p=>p.name===nm);
    if(ex>=0) list[ex]={name:nm,style}; else list.push({name:nm,style});
    savePresets(list); renderTrackStyle(); showToast('已儲存常用樣式：'+nm);
  });
  $('tsPresetSel').addEventListener('change',e=>{
    const i=State.listTrack, v=e.target.value; e.target.value='';
    if(!v||!State.tracks[i])return;
    const p=getPresets().find(x=>x.name===v); if(!p)return;
    Object.assign(State.tracks[i], p.style);
    styleChanged(); recordHistory('套用常用樣式：'+v);
  });
  $('tsPresetMgr').addEventListener('click',()=>{
    const list=getPresets();
    if(!list.length){ showToast('尚無常用樣式；先用「☆ 存為常用」建立'); return; }
    const rows=list.map((p,i)=>`<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--line,#333)">`+
      `<span style="flex:1">${escapeHTML(p.name)}</span>`+
      `<button class="ts-preset" data-pre-ren="${i}">改名</button><button class="ts-preset" data-pre-del="${i}">刪除</button></div>`).join('');
    openModal('⚙ 常用樣式管理', `<div style="max-height:300px;overflow:auto">${rows}</div>`, [{label:'關閉',primary:true,act:closeModal}]);
    setTimeout(()=>{ document.querySelectorAll('[data-pre-del]').forEach(b=>b.onclick=()=>{ const l=[...getPresets()]; l.splice(+b.dataset.preDel,1); savePresets(l); closeModal(); renderTrackStyle(); showToast('已刪除'); });
      document.querySelectorAll('[data-pre-ren]').forEach(b=>b.onclick=()=>{ const l=[...getPresets()]; const p=l[+b.dataset.preRen]; const nn=prompt('新名稱',p.name); if(nn&&nn.trim()){ p.name=nn.trim(); savePresets(l); closeModal(); renderTrackStyle(); } }); },0);
  });
  /* 全軌統一：清掉本軌所有「逐句樣式覆蓋」，讓每句都回到軌道樣式。
     ── 軌道樣式本來就是全軌生效；唯一會脫隊的就是設過覆蓋的句子（列表標 ✱ 自訂）。
        本鈕＝那些句子的一鍵歸隊，而非「把樣式複製到每一句」。 */
  $('tsUnify')?.addEventListener('click',()=>{
    const i=State.listTrack; const trk=State.tracks[i]; if(!trk)return;
    const hits=State.cues.filter(c=>(c.track||0)===i && c.style && Object.keys(c.style).length);
    if(!hits.length){ showToast('本軌沒有逐句覆蓋——所有字幕已經都跟著軌道樣式了'); return; }
    openModal('⇩ 全軌統一', `<div style="font-size:13px;line-height:1.7">`+
      `「${escapeHTML(trk.name)}」有 <b style="color:var(--accent)">${hits.length}</b> 句設了逐句樣式覆蓋。<br>`+
      `清除後，這些句子會改用上方的軌道樣式（可 <b>Ctrl+Z</b> 復原）。</div>`,
      [{label:'取消',act:closeModal},{label:`清除 ${hits.length} 句的覆蓋`,primary:true,act:()=>{
        closeModal();
        for(const c of hits) delete c.style;
        styleChanged(); drawTimeline(); // 摘要就地更新（不整份重繪，捲動位置留在原處）；時間軸重畫掉 ✱ 標記
        recordHistory('全軌統一樣式（清除 '+hits.length+' 句覆蓋）');
        showToast('已清除 '+hits.length+' 句的逐句覆蓋');
      }}]);
  });
  // 預設按鈕（大小 / 位置 / 顏色）— 委派事件到面板
  $('trackStyle').addEventListener('click',e=>{
    const i=State.listTrack; if(!State.tracks[i])return;
    const sz=e.target.closest('.ts-preset[data-ts-size]');
    if(sz){ const v=+sz.dataset.tsSize; State.tracks[i].fontSize=v; $('tsSize').value=v; styleChanged(); return; }
    // 對齊＝多行/多句彼此的對齊方式（同時決定文字塊以哪一側對齊座標）；位置一律由 X/Y 數值決定
    const vg=e.target.closest('.ts-preset[data-ts-valign]');
    if(vg){ State.tracks[i].valign=vg.dataset.tsValign; styleChanged(); return; }
    const ag=e.target.closest('.ts-preset[data-ts-align]');
    if(ag){ State.tracks[i].align=ag.dataset.tsAlign; styleChanged(); return; }
    const cl=e.target.closest('.ts-clr');
    if(cl){ const v=cl.dataset.color; State.tracks[i].color=v; $('tsColor').value=v; styleChanged(); }
  });
  // 字幕檢查：字數上限輸入
  $('cpLenInput').addEventListener('input',()=>{ renderCheckPanel(); renderSubList(); });
  $('cpLenInput').addEventListener('keydown',e=>e.stopPropagation());
  // 字幕檢查：包含文字輸入
  $('cpContainsInput').addEventListener('input',()=>{ renderCheckPanel(); renderSubList(); });
  $('cpContainsInput').addEventListener('keydown',e=>e.stopPropagation());
  // 搜尋浮動視窗
  $('searchInput').addEventListener('input',()=>searchUpdate());
  $('searchInput').addEventListener('keydown',e=>{ e.stopPropagation(); if(e.isComposing) return; if(e.key==='Enter'){ searchNav(1); } else if(e.key==='Escape'){ $('searchInput').value=''; searchUpdate(); $('searchDialog').style.display='none'; _syncMpvPanel(); } });
  $('replaceInput').addEventListener('keydown',e=>e.stopPropagation());
  // 搜尋視窗可拖曳
  { const head=$('searchDialogHead'), dlg=$('searchDialog');
    if(head&&dlg){ let ox=0,oy=0,sx=0,sy=0;
      head.addEventListener('mousedown',e=>{ e.preventDefault();
        const r=dlg.getBoundingClientRect(); ox=r.left; oy=r.top; sx=e.clientX; sy=e.clientY;
        const mv=e2=>{ dlg.style.left=(ox+e2.clientX-sx)+'px'; dlg.style.top=(oy+e2.clientY-sy)+'px'; dlg.style.right='auto'; };
        const up=()=>{ document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); };
        document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
      });
    }
  }
  // 軌道區垂直捲動：時間軸 <-> 左欄 同步
  let _sync=false; const gt=$('tlGutterTracks');
  tlTracks.addEventListener('scroll',()=>{ if(_sync)return; _sync=true; gt.scrollTop=tlTracks.scrollTop; _sync=false; },{passive:true});
  gt.addEventListener('scroll',()=>{ if(_sync)return; _sync=true; tlTracks.scrollTop=gt.scrollTop; _sync=false; },{passive:true});
  // 同步右下角狀態列的選取狀態至中間時間軸工具列
  const stSel = $('stSel'), tlSel = $('tlSel');
  if(stSel && tlSel) {
    const updateTl = () => {
      const txt = stSel.textContent;
      if(!txt || txt==='未選取') {
        tlSel.textContent = '未選取';
        tlSel.className = 'sel-none';
        stSel.className = 'sel-none';
        if(txt !== '未選取') stSel.textContent = '未選取';
      } else {
        tlSel.textContent = txt;
        if(txt.includes('已選 1 條')) {
           tlSel.className = 'sel-one';
           stSel.className = 'sel-one';
        } else {
           tlSel.className = 'sel-multi';
           stSel.className = 'sel-multi';
        }
      }
    };
    new MutationObserver(updateTl).observe(stSel, { childList: true, characterData: true, subtree: true });
    updateTl(); // initial sync
  }
  // 區塊分隔線：拖曳調整 字幕列表寬度 / 時間軸高度
  const _LAYOUT_KEY='sub_layout_v2';
  const saveLayout=()=>{
    const gt=$('tlGutter');
    localStorage.setItem(_LAYOUT_KEY,JSON.stringify({
      rw:$('rightPanel').style.width||'',
      th:$('timelinePanel').style.height||'',
      gw:gt?gt.style.width||'':''
    }));
  };
  const loadLayout=()=>{
    try{
      const d=JSON.parse(localStorage.getItem(_LAYOUT_KEY)||'{}');
      if(d.rw) $('rightPanel').style.width=d.rw;
      if(d.th) $('timelinePanel').style.height=d.th;
      const gt=$('tlGutter'); if(d.gw&&gt) gt.style.width=d.gw;
    }catch(_){}
  };
  const dragSplit=(handle,onMove)=>{ handle.addEventListener('mousedown',e=>{ e.preventDefault();
    const mv=ev=>onMove(ev); const up=()=>{document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);drawTimeline();saveLayout();};
    document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up); }); };
  const right=$('rightPanel'), tl=$('timelinePanel');
  dragSplit($('splitV'),ev=>{ right.style.width=clamp(window.innerWidth-ev.clientX-3,220,window.innerWidth-360)+'px'; });
  dragSplit($('splitH'),ev=>{ const r=tl.getBoundingClientRect(); tl.style.height=clamp(r.bottom-ev.clientY,140,window.innerHeight-200)+'px'; drawTimeline(); });
  // 軌道欄寬度調整
  { const sp=$('tlGutterSplitter'), gt=$('tlGutter');
    if(sp&&gt){ let sx=0,sw=0;
      sp.addEventListener('mousedown',e=>{ e.preventDefault(); sx=e.clientX; sw=gt.offsetWidth;
        const mv=ev=>{ gt.style.width=clamp(sw+(ev.clientX-sx),60,360)+'px'; drawTimeline(); };
        const up=()=>{ document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); saveLayout(); };
        document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up); });
    }
  }
  loadLayout();
  renderListTrackSel();
  // 點擊時間軸時解除輸入框焦點
  $('timelinePanel').addEventListener('mousedown',()=>{ const ae=document.activeElement; if(ae&&(ae.tagName==='INPUT'||ae.tagName==='SELECT'))ae.blur(); },{capture:true});

  // 任何按鈕點擊後立即解除焦點，避免 Space/Enter 誤觸
  document.addEventListener('click',e=>{ const btn=e.target.closest('button'); if(btn)btn.blur(); },{capture:true});


}

/* ===== 磁吸 / 防重疊 工具 ===== */
/* ===== 複製軌道 ===== */
function doCopyTrack(){
  const srcIdx=State.listTrack;
  const srcTrack=State.tracks[srcIdx];
  if(!srcTrack){ showToast('請先選擇一個字幕軌道'); return; }
  const srcCues=State.cues.filter(c=>(c.track||0)===srcIdx);
  openModal('複製字幕軌道',
    `<p>將 <b>${escapeHTML(srcTrack.name)}</b> 的 <b>${srcCues.length}</b> 條字幕複製到新軌道，請選擇複製方式：</p>`,
    [
      { label:'含文字內容', primary:true, act:()=>{ closeModal(); _execCopyTrack(srcIdx,true); } },
      { label:'僅複製時間點（文字清空）', act:()=>{ closeModal(); _execCopyTrack(srcIdx,false); } },
      { label:'取消', act:closeModal }
    ]
  );
}
function _execCopyTrack(srcIdx, withText){
  const srcTrack=State.tracks[srcIdx]; if(!srcTrack)return;
  // 產生唯一軌道名稱
  const base=srcTrack.name+'_複製';
  let name=base, n=1;
  const names=State.tracks.map(t=>t.name);
  while(names.includes(name)) name=base+(n++);
  // 複製軌道屬性
  const tk={name, visible:true, fontSize:srcTrack.fontSize||60, posPct:srcTrack.posPct!=null?srcTrack.posPct:90,
             align:srcTrack.align||'center', locked:false, color:srcTrack.color||'#ffffff'};
  const newIdx=State.tracks.length;
  State.tracks.push(tk); syncTrackCount();
  // 複製字幕
  const srcCues=State.cues.filter(c=>(c.track||0)===srcIdx);
  for(const c of srcCues)
    State.cues.push({id:newId(), start:c.start, end:c.end, text:withText?(c.text||''):'', track:newIdx, timed:c.timed});
  sortCues(); renderAll(); drawTimeline();
  State.listTrack=newIdx; renderListTrackSel(); renderSubList();
  recordHistory('複製字幕軌道');
  showToast(`已複製到「${name}」（${srcCues.length} 條）`);
}

function openNoteInPanel(n){
  $('notesPanel').classList.add('show');
  setNoteActive(n.id);
  renderNotes();
  setTimeout(()=>{
    $('notesList')?.querySelector(`[data-id="${n.id}"]`)?.scrollIntoView({block:'nearest'});
  },30);
}
/* 開啟浮動面板時，若面板與影片重疊就自動推到影片右側，避免開啟時畫面變黑 */
function _ensurePanelInRightArea(panel){
  if(!Media.mpvMode||!window.subtool?.mpv) return;
  const vr=$('videoWrap')?.getBoundingClientRect();
  if(!vr) return;
  const pr=panel.getBoundingClientRect();
  if(pr.left < vr.right + 4){
    panel.style.right='auto'; panel.style.bottom='auto';
    panel.style.left=(vr.right+8)+'px';
    panel.style.top=Math.max(50, Math.min(pr.top, window.innerHeight-120))+'px';
  }
}

function togglePanel(id){ const p=$(id); const willShow=!p.classList.contains('show');
  document.querySelectorAll('.float-panel.show').forEach(x=>x.classList.remove('show'));
  if(willShow){ p.classList.add('show'); setTimeout(()=>{ _ensurePanelInRightArea(p); _syncMpvPanel(); },0); }
  else _syncMpvPanel();
}

/* ===== 播放時間數字：雙擊輸入 / 右鍵複製 ===== */
function startTimeEdit(){
  const span=$('tcCur'); if(span.querySelector('input'))return;
  const old=span.textContent;
  const inp=document.createElement('input'); inp.className='tc-edit'; inp.value=''; inp.placeholder=old;
  span.textContent=''; span.appendChild(inp); inp.focus();
  let done=false;
  const fin=(commit)=>{ if(done)return; done=true; inp.remove(); span.textContent=secToEncore(Media.displayTime(),State.fps,State.dropFrame);
    if(commit){
      const raw=inp.value.trim(); let t=null;
      if(raw.startsWith('+')||raw.startsWith('-')){
        const sign=raw.startsWith('-')?-1:1;
        const delta=parseTimecodeInput(raw.slice(1));
        if(delta!==null){ t=Media.displayTime()+sign*delta;
          if(t<0){ showToast('時間不能早於 00:00:00:00'); return; } }
      } else { t=parseTimecodeInput(raw); }
      if(t==null){ /* 空：不變 */ }
      else if(t>State.duration+1e-6){ showToast('超過片長'); }
      else { Media.seek(t); updatePlayhead(); ensurePlayheadVisible(); } } };
  inp.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();fin(true);} else if(e.key==='Escape'){e.preventDefault();fin(false);} });
  inp.addEventListener('blur',()=>fin(true));
}
function initExtras(){
  // 調整面板：分頁切換
  document.querySelectorAll('.shift-tab').forEach(tab=>{
    tab.addEventListener('click',e=>{
      e.stopPropagation();
      document.querySelectorAll('.shift-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      const isTc=tab.dataset.tab==='tc';
      $('shiftPageTc').style.display=isTc?'':'none';
      $('shiftPageDur').style.display=isTc?'none':'';
    });
  });
  // 調整持續時間：增減時長 vs 百分比 切換
  $('durAdjMode')?.addEventListener('change',()=>{
    const isTc=$('durAdjMode').value==='tc';
    $('durAdjTcRow').style.display=isTc?'':'none';
    $('durAdjPctRow').style.display=isTc?'none':'';
  });
  // 新輸入框鍵盤事件
  const formatTcInput = (el) => {
    if(!el) return;
    const raw = el.value.trim().replace(/^[+-]/, '');
    const sign = el.value.trim().startsWith('-') ? '-' : (el.value.trim().startsWith('+') ? '+' : '');
    const t = parseTimecodeInput(raw);
    if (t !== null) el.value = sign + secToEncore(t, State.fps, State.dropFrame);
  };
  ['tcShiftInput', 'durAdjTcInput'].forEach(id => {
    const el = $(id);
    if(el) {
      el.addEventListener('blur', () => formatTcInput(el));
      setupTimecodeInput(el);
      el.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); formatTcInput(el); }
      });
    }
  });
  $('durAdjPctInput')?.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();applyDurAdjPct();} });
  $('durAdjMode')?.addEventListener('keydown',e=>e.stopPropagation());
  $('waveSrcSel')?.addEventListener('change',e=>{ Wave.selectSource(+e.target.value); e.target.blur(); });
  $('tcCur').addEventListener('dblclick',e=>{ e.preventDefault(); startTimeEdit(); });
  $('tcCur').addEventListener('contextmenu',e=>{ e.preventDefault();
    try{ navigator.clipboard.writeText(secToEncore(Media.displayTime(),State.fps,State.dropFrame)); showToast('已複製時間碼'); }catch(err){} });
  // 浮動面板拖曳（拖 fp-head 移動整個面板）
  document.querySelectorAll('.float-panel').forEach(panel=>{
    const head=panel.querySelector('.fp-head'); if(!head)return;
    let ox=0,oy=0,sx=0,sy=0;
    head.addEventListener('mousedown',e=>{
      if(e.target.closest('button'))return;
      e.preventDefault();
      const r=panel.getBoundingClientRect();
      panel.style.right='auto'; panel.style.bottom='auto';
      panel.style.left=r.left+'px'; panel.style.top=r.top+'px';
      ox=r.left; oy=r.top; sx=e.clientX; sy=e.clientY;
      document.body.style.cursor='grabbing';
      const mv=e2=>{
        panel.style.left=clamp(ox+e2.clientX-sx,0,window.innerWidth-60)+'px';
        panel.style.top=clamp(oy+e2.clientY-sy,0,window.innerHeight-40)+'px';
        _syncMpvPanel();
      };
      const up=()=>{
        document.body.style.cursor='';
        document.removeEventListener('mousemove',mv);
        document.removeEventListener('mouseup',up);
        _syncMpvPanel();
      };
      document.addEventListener('mousemove',mv);
      document.addEventListener('mouseup',up);
    });
  });
}

/* resize */
let rzT;
window.addEventListener('resize',()=>{clearTimeout(rzT);rzT=setTimeout(()=>{drawTimeline();renderVideoSub();},120);});

/* 下拉選單/數字輸入選定後自動失焦，避免攔截鍵盤快捷鍵 */
document.addEventListener('change',(e)=>{
  const t=e.target;
  if(t.tagName==='SELECT' || (t.tagName==='INPUT' && t.type==='number')){
    setTimeout(()=>t.blur(),0);
  }
});

/* 初始化 */
function applyAriaLabels(){
  // X1：純圖示按鈕多半只有 title，報讀器在 button 模式下不穩定念出 title；
  // 啟動時把 title 複製成 aria-label，一次覆蓋整份靜態工具列。
  document.querySelectorAll('button[title]:not([aria-label])').forEach(b=>{
    const t=(b.getAttribute('title')||'').trim();
    if(t) b.setAttribute('aria-label', t);
  });
}

function updateConfigUI() {
  document.querySelectorAll('.auto-select-btn').forEach(btn => {
    btn.textContent = State.autoSelect ? '自動選取' : '不自動選取';
    btn.classList.toggle('on', State.autoSelect);
  });
  document.querySelectorAll('.ow-toggle-btn').forEach(btn => {
    btn.textContent = State.overwriteMode ? '🔓 可覆蓋' : '🔒 不覆蓋';
    btn.classList.toggle('primary', State.overwriteMode);
  });
  document.querySelectorAll('.ow-keep-btn').forEach(btn => {
    btn.classList.toggle('inactive-mode', !State.overwriteMode);
    btn.textContent = State.overwriteKeep ? '⚪ 保留' : '❌ 刪除';
    btn.classList.toggle('del', !State.overwriteKeep);
  });
}

async function init(){
  await loadConfig();
  await loadKeys();
  updateConfigUI();
  State.fps=+$('fpsSel').value||24;
  const brandLogo=$('brandLogo'); if(brandLogo) brandLogo.src=_logoUrl;
  initUI(); initExtras(); applyAriaLabels();
  renderAll(); layoutTimeline(); drawTimeline(); rafLoop();
  loadPresets().then(()=>renderTrackStyle()).catch(()=>{}); // v4.23 常用樣式庫（config 持久化）
  // v4.25.4 字幕字型：掃 <專案根>/font/ → 注入 @font-face → 填字型下拉（預覽與匯出同一份字型）
  loadFonts().then(fonts=>{
    const sel=$('tsFont'); if(!sel) return;
    if(fonts.length){
      const cur=sel.value;
      sel.innerHTML=fonts.map(f=>`<option>${escapeHTML(f.name)}</option>`).join('')+'<option value="__custom">自訂…</option>';
      if(cur && [...sel.options].some(o=>o.value===cur)) sel.value=cur;
    }
    renderVideoSub(); renderTrackStyle();
  }).catch(()=>{});
  History.reset();
  if(IS_DESKTOP) initDesktop();
  else setStatus('就緒 — 匯入影音或字幕開始','ok');
}
async function initDesktop(){
  const brand=document.querySelector('.brand');
  if(brand && !brand.querySelector('small')){ const sm=document.createElement('small'); sm.style.cssText='opacity:.55;font-size:11px;margin-left:6px;vertical-align:middle'; sm.textContent='桌面版'; brand.appendChild(sm); }
  document.querySelectorAll('.desktop-only').forEach(el=>{ el.style.display=''; }); // 顯示桌面專屬功能（匯出影片等）
  const nv=$('noVideo'); if(nv) nv.innerHTML='<b>尚未載入影音</b>點 <kbd>🎬 影音</kbd> 匯入<br>桌面版支援 MP4 / MOV / <b>MXF</b> / MKV / 多音軌（系統 ffmpeg）<br>多音軌可同時混音播放，每軌獨立音量／獨奏';
  try{
    const s=await DESK.status();
    const eng=$('stEngine');
    if(eng){
      const hasGpu = !!(s.venc && s.venc !== 'libx264');
      eng.innerHTML = '引擎：' + (s.ffmpeg
        ? '系統 ffmpeg ✓' + (hasGpu
            ? ` · <b style="color:var(--green)">GPU ${String(s.venc).replace('h264_','').toUpperCase()}</b>`
            : ' · <span style="color:var(--text-faint)">CPU 編碼</span>')
        : '⚠ 未偵測到 ffmpeg');
      eng.title = s.ffmpeg
        ? (hasGpu
            ? `已偵測到 GPU 編碼器：${s.venc}\n· MP4（H.264）匯出：使用 GPU 編碼\n· ProRes 422 HQ 匯出：CPU 編碼（ffmpeg 無 GPU ProRes 編碼器）\n· 來源解碼：嘗試硬體加速\n匯出完成後，狀態列會顯示本次「實際使用」的編碼器。`
            : '未偵測到 GPU 編碼器，H.264 將以 CPU（libx264）編碼。')
        : '未偵測到 ffmpeg';
    }
    if(!s.ffmpeg) openModal('未偵測到 ffmpeg',
      `桌面版的 MXF 轉檔與多音軌抽取需要系統安裝 <b>ffmpeg</b>。<br><br>`+
      `偵測位置：PATH、<code>C:\\Program Files\\FFMPEG\\bin\\</code> 等。<br>`+
      `可至 <b>ffmpeg.org</b> 下載後加入 PATH，或設環境變數 <code>FFMPEG_PATH</code>。<br><br>`+
      `原生 MP4/MOV/MP3/WAV 播放與字幕編輯不受影響。`);
    setStatus('就緒（桌面模式）— 可直接讀 MXF 與多音軌','ok');
  }catch(e){ setStatus('就緒（桌面模式）','ok'); }
  DESK.onProgress(d=>{
    if(!d.done && d.pct<100) setStatus((d.label||'處理中')+'… '+d.pct+'%','busy','lock');
    if(d.done) {
      setStatus('轉檔完成', 'ok', 'unlock');
      window.dispatchEvent(new CustomEvent('desk:ingest-done',{detail:d}));
    }
  });
  
  const handleStartupFile = async (file) => {
    if (!file) return;
    try {
      const b64 = await DESK.readB64(file);
      if (b64) Project.loadDesktop({ path: file, b64 });
      else setStatus('無法讀取專案檔內容');
    } catch(e) { console.error(e); }
  };
  
  if (DESK.getStartupFile) {
    DESK.getStartupFile().then(handleStartupFile);
  }
  if (DESK.onOpenFile) {
    DESK.onOpenFile(handleStartupFile);
  }
  if (DESK.onAppRequestClose) {
    DESK.onAppRequestClose(() => {
      if (isProjectDirty()) {
        openModal('儲存變更', '關閉前是否要儲存專案？', [
          // 等儲存真正完成（拿到路徑）才關閉；使用者取消存檔對話框則回到編輯畫面，避免資料遺失
          {label: '儲存', primary: true, act: async () => { const pth = await Project.save(); if (pth) DESK.closeApp(); else closeModal(); }},
          {label: '不儲存', act: () => { DESK.closeApp(); }},
          {label: '取消', act: () => { closeModal(); }}
        ]);
      } else {
        DESK.closeApp();
      }
    });
  }
}

/* 除錯把手：一律暴露（單機工具無安全疑慮）。
   桌面版遇到問題時可開 DevTools 以 window.SUB 檢視狀態，遠端診斷也依賴它。 */
{
  window.SUB = { State, Media, Wave, SubFormats, Project,
    selectCue, selectCueSingle, refreshSelectionUI, isSel, stepBoundary, setIn, setOut,
    addCue, addCueRelative, deleteSelected, moveSelectedToTrack, addTrack, removeTrack,
    renderAll, drawTimeline, renderVideoSub, renderSubList, renderListTrackSel, renderTrackStyle,
    renderCueBlocks, trackFromY, secToEncore, secToSRT, secToASS, newId, ensureTrackCount,
    syncTrackCount, sortCues, onDurationKnown, setZoom, zoomFit, zoomFitVideo, showCueMenu, showPlayerMenu,
    History, recordHistory, renderHistory, addNote, renderNotes, togglePanel,
    parseTimecodeInput, snapVal, snapTargets, neighborBounds, setFps, snapFps, FPS_SET,
    toASSFromState, _stageRect }; // 三路一致診斷：ASS 產出＋字幕層座標基準（畫面實際顯示區）
  window.SUB.WC = { pocTest: _wcPocTest, demuxFile: _wcDemux, TrackDecoder: _wcTrackDecoder, preview: WCPreview,
    demuxIndex: _wcDemuxIndex, SampleReader: _wcSampleReader }; // 階段0 PoC＋階段1 預覽＋v4.29 串流式 demux（驗證/診斷入口）
  window.SUB.SubStyle = { effStyle, styleToCss, verticalChars, STYLE_DEFAULTS, loadPresets, getPresets, savePresets, trackStyleSnapshot, loadFonts, getFonts }; // v4.23 字幕樣式（驗證/診斷入口）
}

init();

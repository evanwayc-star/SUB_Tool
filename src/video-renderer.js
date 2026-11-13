import { $, video, tlScroll, tlLayer } from './dom.js';
import { State, isSel, setSelection, deselect, IS_DESKTOP, saveConfig, trackVisible, videoTrackVisible } from './state.js';
import { Media } from './media.js';

import { Seq } from './sequence.js';
import { emit, on } from './events.js';
import { getExactFps, secToEncore } from './time.js';
import { effStyle, styleToCss, ASS_PLAY_RES, anchorPct } from './substyle.js';
import { escapeHTML } from './util.js';
import { getPlayerAdapter, getNativePreviewRuntime } from './media-player-adapter.js';
import { toASSFromState } from './subio.js';
import { createPreviewDrag } from './timeline-interaction-engine.js';
import { drawTimeline, updatePlayhead } from './timeline-renderer.js';
import { renderAudioTracks, clearMeterStrips } from './mixer.js';
import { Wave } from './media.js';
import { imageBoxOnStage, imageLayerPlan, imageSourceUrl, visualStackPlan, stageBox, fadeAlphaAtTimeline } from './image-compositor-engine.js';
import { renderASS } from './formats.js';
import { measureSubtitleBackgroundLayouts } from './subtitle-background-layout.js';
import { History, recordHistory } from './history.js';
import { showToast, setMpvWindowVisible } from './ui.js';
import { refreshSelectionUI, selectCueSingle } from './subtitles.js';
import { subtitlePreviewIndex } from './subtitle-preview-index.js';
import { setMediaElementSource } from './media-intake-engine.js';
import { projectCanvasSize, projectCanvasRect } from './project-canvas.js';

let _mpvSubT=null;
let _lastMpvSubSend=0;
let _revealMpvSubsAfterRefresh=false;
export let _firstLoad=true;
export function setFirstLoad(v){ _firstLoad=v; } // 第一次載入影片或字幕時自動 zoomFitVideo；新專案後重置
export function refreshMpvSubs(revealAfter=false, live=false){
  if(!Media.mpvMode || !getPlayerAdapter().isAvailable) return;
  if(revealAfter===true) _revealMpvSubsAfterRefresh=true;
  clearTimeout(_mpvSubT);
  // 一般變更維持防抖；直接拖曳則節流到約 12fps，讓 mpv/libass 仍可即時預覽位置，
  // 又不會每個 pointermove 都重載一次 ASS。
  const delay=live ? Math.max(0,80-(performance.now()-_lastMpvSubSend)) : 150;
  _mpvSubT=setTimeout(async()=>{
    try{
      _lastMpvSubSend=performance.now();
      // 序列：mpv/libass 以【來源時間】渲染字幕，而 cue 時碼為【時間軸時間】——
      // 依當前 clip 的映射（來源 = 時間軸 - offset + in）整批平移後再餵給 mpv
      const c=Media.seqOn() ? Media.activeClip() : null;
      // live 也必須先用時間軸位置篩選，最後才映射成 mpv 的來源時間。
      const cs=Seq.timedRangesForSource(State.cues,c,live
        ? {center:Media.displayTime(),radius:5}
        : {});
      let assStr;
      if(State.presetEdit) {
        const previewText = document.getElementById('tsEditPreviewText')?.value || '田這是一段|範例字幕田\n田 ABC123|321CBA 田';
        const draftCue = { id: 'draft_preview', start: 0, end: State.duration || 36000, text: previewText, track: 0, timed: true, style: {} };
        const tempTracks = [State.presetEdit.draft];
        const previewCues = [draftCue];
        assStr = renderASS(previewCues, {
          fps: State.fps,
          tracks: tempTracks,
          backgroundLayouts: measureSubtitleBackgroundLayouts(previewCues, tempTracks),
        });
      } else if (live) {
        assStr = toASSFromState(cs);
        
        clearTimeout(window._mpvSubFullT);
        window._mpvSubFullT = setTimeout(() => refreshMpvSubs(false, false), 500);
      } else {
        assStr = toASSFromState(cs);
      }
      if(State.safeFrame) {
        const sf = [];
        // 以 1920x1080 畫布為基準產生四邊矩形邊框
        // 100%
        sf.push(`Dialogue: 0,0:00:00.00,9:59:59.99,Default,,0,0,0,,{\\an7\\pos(0,0)\\p1\\1a&HFF&\\3c&HFFA300&\\3a&H00&\\bord2}m 2 2 l 1918 2 l 1918 1078 l 2 1078`);
        // 90%
        sf.push(`Dialogue: 0,0:00:00.00,9:59:59.99,Default,,0,0,0,,{\\an7\\pos(0,0)\\p1\\1a&HFF&\\3c&HFFFFFF&\\3a&H77&\\bord1}m 96 54 l 1824 54 l 1824 1026 l 96 1026`);
        // 80%
        sf.push(`Dialogue: 0,0:00:00.00,9:59:59.99,Default,,0,0,0,,{\\an7\\pos(0,0)\\p1\\1a&HFF&\\3c&H5ADCF0&\\3a&H55&\\bord2}m 192 108 l 1728 108 l 1728 972 l 192 972`);
        // 中心十字線 (垂直、水平)
        sf.push(`Dialogue: 0,0:00:00.00,9:59:59.99,Default,,0,0,0,,{\\an7\\pos(960,0)\\p1\\1c&HFFFFFF&\\1a&H77&\\bord0}m -1 0 l 1 0 l 1 1080 l -1 1080`);
        sf.push(`Dialogue: 0,0:00:00.00,9:59:59.99,Default,,0,0,0,,{\\an7\\pos(0,540)\\p1\\1c&HFFFFFF&\\1a&H77&\\bord0}m 0 -1 l 1920 -1 l 1920 1 l 0 1`);
        assStr += '\n' + sf.join('\n') + '\n';
      }
      await getPlayerAdapter().subSet(assStr);
      // 只在拖曳結束時才重新露出 mpv/libass 字幕，避免舊位置與 DOM 預覽重疊。
      if(_revealMpvSubsAfterRefresh){
        _revealMpvSubsAfterRefresh=false;
        getPlayerAdapter().subVisible?.(true).catch(()=>{});
      }
    }catch(e){}
  },delay);
}
/* mpv 是 OS 層子視窗，HTML z-index 蓋不過它。把可見疊層交給
   host 局部裁切，保留未遮住的原生畫面，不切換 presenter 或播放時鐘。 */
let _mpvOverlayObserver=null;
let _mpvObservedOverlays=new Set();
function _watchMpvOverlays(elements){
  if(!_mpvOverlayObserver && elements.length && typeof ResizeObserver==='function')
    _mpvOverlayObserver=new ResizeObserver(()=>_syncMpvPanel());
  if(!_mpvOverlayObserver) return;
  const next=new Set(elements);
  for(const element of _mpvObservedOverlays) if(!next.has(element)) _mpvOverlayObserver.unobserve(element);
  for(const element of next) if(!_mpvObservedOverlays.has(element)) _mpvOverlayObserver.observe(element);
  _mpvObservedOverlays=next;
}
export function _syncMpvPanel(){
  if(!Media.mpvMode || !window.subtool?.mpv){ _watchMpvOverlays([]); return; }
  const wrap=$('videoWrap'),vr=wrap?.getBoundingClientRect();
  const observed=wrap?[wrap]:[];
  if(!vr || !(vr.width>0 && vr.height>0)){
    _watchMpvOverlays(observed); setMpvWindowVisible(false); return;
  }
  const occluders=[];
  const add=element=>{
    if(!element) return;
    const style=getComputedStyle(element);
    if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse') return;
    observed.push(element);
    const r=element.getBoundingClientRect();
    if(!(r.width>0&&r.height>0)||r.right<=vr.left||r.left>=vr.right||r.bottom<=vr.top||r.top>=vr.bottom) return;
    occluders.push({x:r.left,y:r.top,w:r.width,h:r.height});
  };
  // Only the dialog itself covers the native video, not its full-screen backdrop.
  if($('modalBg')?.classList.contains('show')) add($('modalBg').querySelector('.modal'));
  add(document.querySelector('#settingsModal .settings-modal-content'));
  document.querySelectorAll('.float-panel.show').forEach(add);
  add($('searchDialog'));
  if($('ctxmenu')?.classList.contains('show')) add($('ctxmenu'));
  document.querySelectorAll('.menu.open .items').forEach(add);
  _watchMpvOverlays(observed);
  getNativePreviewRuntime().setNativeViewport({
    bounds:{x:vr.left,y:vr.top,w:vr.width,h:vr.height},
    visible:!Media.inGap()&&!Media.webCodecsTakeover(),
    occluders,
  }).catch(()=>{});
}
const _videoSub = $('videoSub');
const _videoWrap = $('videoWrap');
let _videoSubSig = '';
let _mpvSubtitleDrag = false;
let _hoveredSubEl = null;
function _sendMpvSubtitleGuide(el){
  const mpv=getPlayerAdapter();
  if(!mpv?.setGuide) return;
  if(!el || !Media.mpvPresenting() || _mpvSubtitleDrag){ mpv.setGuide(null).catch(()=>{}); return; }
  const wrap=_videoWrap?.getBoundingClientRect(), box=el.getBoundingClientRect();
  if(!wrap || !box.width || !box.height){ mpv.setGuide(null).catch(()=>{}); return; }
  mpv.setGuide({ x:box.left-wrap.left-3, y:box.top-wrap.top-3, w:box.width+6, h:box.height+6 }).catch(()=>{});
}
export function _setSubtitleHover(el){
  if(el===_hoveredSubEl) return;
  _hoveredSubEl?.classList.remove('hovering');
  _hoveredSubEl=el||null;
  _hoveredSubEl?.classList.add('hovering');
  _sendMpvSubtitleGuide(_hoveredSubEl);
}
/* 專案畫布 contain 到 videoWrap：字幕、安全框、圖片及拖曳共用此矩形。
   自訂尺寸獨立於來源；Auto 沿用主影片 metadata，未載入時退回 1920×1080。
   字幕字級仍依畫布顯示高度 / ASS PlayResY 縮放。 */
export function _stageRect(){
  if(!_videoWrap) return null;
  return projectCanvasRect(_videoWrap.clientWidth,_videoWrap.clientHeight);
}
/* 安全框（v4.33）：90%／80% 安全區＋中心十字線，疊在 videoWrap 上供構圖參考。
   ── 僅預覽：畫在獨立的 #safeFrame，【不】經 ffmpeg 燒入匯出。
   ── 對齊影片實際顯示區 _stageRect()（與字幕層同一個框），不同比例的片都貼合畫面。
   由 renderVideoSub 每幀呼叫（rafLoop／resize／seek 都會觸發）→ 自動跟著畫面對齊。 */
const _safeFrame = $('safeFrame');
export function drawSafeFrame(){
  if(!_safeFrame) return;
  const on = !!State.safeFrame;
  _safeFrame.classList.toggle('on', on);
  if(!on) return;
  
  const r = _stageRect(); if(!r || !r.w || !r.h) return;
  // 將 safeFrame 對齊畫面顯示區 _stageRect()
  const key = r.x+'|'+r.y+'|'+r.w+'|'+r.h;
  if(_safeFrame.dataset.rect !== key){
    _safeFrame.dataset.rect = key;
    const st = _safeFrame.style;
    st.left = r.x+'px'; st.top = r.y+'px';
    st.width = r.w+'px'; st.height = r.h+'px';
    st.right = 'auto'; st.bottom = 'auto'; st.margin = '0';
  }
}
export function toggleSafeFrame(){
  State.safeFrame = !State.safeFrame;
  $('safeFrameBtn')?.classList.toggle('active', State.safeFrame);
  drawSafeFrame(); saveConfig(); refreshMpvSubs();
  showToast(State.safeFrame ? '安全框：開（100%／90%／80%＋中心十字）' : '安全框：關');
}

/* 時間碼浮水印：純播放器監看疊層，不經 ASS／ffmpeg，因此不會被燒進輸出檔。
   一般預覽用 DOM；MPV 原生畫面蓋在 DOM 上方時，改送到透明的 MPV guide 視窗。 */
const _timecodeWatermark = $('timecodeWatermark');
let _mpvTimecodeWatermarkSig = '';

function syncMpvTimecodeWatermark(text, rect){
  const mpv=getPlayerAdapter();
  if(!mpv?.setTimecodeWatermark) return;
  const nativeMpv=Media.mpvPresenting();
  const payload=(nativeMpv && text && rect?.w && rect?.h) ? {text,rect} : null;
  // 播放時這個函式會跟著 raf 呼叫；只有跨越下一格或畫面大小改變才送 IPC。
  const sig=payload ? `${payload.text}|${payload.rect.x}|${payload.rect.y}|${payload.rect.w}|${payload.rect.h}` : '';
  if(sig===_mpvTimecodeWatermarkSig) return;
  _mpvTimecodeWatermarkSig=sig;
  try{ mpv.setTimecodeWatermark(payload).catch(()=>{}); }catch(e){}
}

export function renderTimecodeWatermark(time=Media.displayTime()){
  const on=!!State.timecodeWatermark;
  const safeTime=Number.isFinite(time)?Math.max(0,time):0;
  const text=secToEncore(safeTime,State.fps,State.dropFrame);
  const value=$('timecodeWatermarkValue');
  if(value) value.textContent=text;

  // 與安全框／字幕同樣貼齊實際可見畫面，不會落在不同長寬比造成的黑邊上。
  const r=_stageRect();
  const nativeMpv=Media.mpvPresenting();
  syncMpvTimecodeWatermark(on&&nativeMpv ? text : '', on&&nativeMpv ? r : null);

  if(!_timecodeWatermark) return;
  _timecodeWatermark.classList.toggle('on',on && !nativeMpv);
  if(!on || !r?.w || !r?.h) return;

  const inset=Math.max(8,Math.round(Math.min(r.w,r.h)*.014));
  const key=`${r.x}|${r.y}|${r.w}|${r.h}|${inset}`;
  if(_timecodeWatermark.dataset.rect!==key){
    _timecodeWatermark.dataset.rect=key;
    const st=_timecodeWatermark.style;
    st.left=(r.x+inset)+'px'; st.top=(r.y+inset)+'px';
    st.right='auto'; st.bottom='auto'; st.margin='0';
  }
}
export function toggleTimecodeWatermark(){
  State.timecodeWatermark=!State.timecodeWatermark;
  const btn=$('timecodeWatermarkBtn');
  btn?.classList.toggle('active',State.timecodeWatermark);
  btn?.setAttribute('aria-pressed',String(State.timecodeWatermark));
  renderTimecodeWatermark(Media.displayTime());
  saveConfig();
  showToast(State.timecodeWatermark?'時間碼浮水印：開（僅播放器監看，不燒入匯出）':'時間碼浮水印：關');
}

let _lastStageH = 0;
let _htmlCanvasRectKey = '';
export function renderVideoSub(fromPlayback=false){
  // 編輯／Undo／匯入由直接 render 或 render:videoSub 進來；只有播放 tick 可沿用索引。
  if(fromPlayback!==true) subtitlePreviewIndex.invalidate();
  drawSafeFrame(); // 安全框跟著畫面每幀對齊
  renderTimecodeWatermark(); // 同步播放器監看時間碼（不參與輸出）
  // 【雙引擎渲染架構說明 (v5.2.0)】
  // 1. 單軌影片 (MPV): mpv.exe 是一個 OS 層級實體視窗 (HWND)，會像一塊黑布一樣完全蓋住底下的 Chrome DOM。
  //    因此，單軌時「必須」依賴 MPV 內建的 C++ libass 引擎，直接將字幕畫在影片上。此時 HTML DOM 僅保留透明命中層供拖曳。
  // 2. 多軌影片 (WebCodecs): MPV 無法進行複雜即時混圖，因此會被隱藏。此時改用 HTML canvas (WCPreview) 渲染畫面，
  //    字幕也就「必須」改由 HTML DOM (#videoSub) 繪製，因為 libass 已經跟著 MPV 被隱藏了。
  // 3. 尺寸對齊: 保留固定 1920×1080 字幕畫布與既有 CSS 字級；ASS 另依已載入字型的實際度量及 CSS 行盒換算。
  // 若 contextmenu 開啟（_ctxOpen），原生 mpv 會讓位，此時需解除 transparent 顯示 HTML 字幕預覽，避免文字不見。
  const mpvHitLayer=!!(Media.mpvPresenting() && !_mpvSubtitleDrag && !State.presetEdit && !window._ctxOpen);
  if(_videoSub){
    _videoSub.classList.toggle('mpv-hit-layer', mpvHitLayer);
    if((!Media.mpvPresenting() || mpvHitLayer || _mpvSubtitleDrag || State.presetEdit) && _videoSub.style.display==='none') _videoSub.style.display='';
  }
  if(!mpvHitLayer) _sendMpvSubtitleGuide(null);
  const t=Media.displayTime();
  const fps = State.fps || 25;
  let exactFps = getExactFps(fps);
  const currentFrame = Math.round(t * exactFps);

  // 字幕層對齊影片實際畫面區（v4.25.3）：大小/位置以「畫面」為基準，各片比例不同也一致
  const rect = _stageRect();
  // Custom canvas contains the source. Auto restores the existing CSS behavior.
  const htmlRectKey=State.projectCanvas&&rect ? `${rect.x}|${rect.y}|${rect.w}|${rect.h}` : '';
  if(video && htmlRectKey!==_htmlCanvasRectKey){
    _htmlCanvasRectKey=htmlRectKey;
    Object.assign(video.style,htmlRectKey
      ? {position:'absolute',left:rect.x+'px',top:rect.y+'px',width:rect.w+'px',height:rect.h+'px'}
      : {position:'',left:'',top:'',width:'',height:''});
  }
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
  // 縮放基準＝畫面【高】/ PlayResY：ASS 的 Fontsize／Outline／Shadow 都是相對 PlayResY 換算的。
  // 舊版用「寬 / PlayResX」——16:9 時寬高等比例所以剛好對得上，一遇到別的比例就整個歪掉：
  // 實測 2.35:1 的片字級佔畫面高 9.9%，而 16:9 與 ASS 都是 7.41%（大了 33%，且與匯出不符）。
  const stageH = (rect && rect.h) || _videoSub?.clientHeight || _lastStageH || ASS_PLAY_RES.y;
  if (stageH > 0) _lastStageH = stageH; // 記住有效的畫面高，避免開啟對話框時 _videoSub 失去高度導致 fallback 回原尺吋放大
  const ratio = stageH / ASS_PLAY_RES.y;
  let html='', sig=(rect ? rect.w+'x'+rect.h : '')+';'; // 畫面區變動（換片/不同比例/視窗縮放）須重繪
  try{
    let tks = [];
    for(let tk=0; tk<State.trackCount; tk++) if(trackVisible(tk)) tks.push(tk);
    if(State.presetEdit) tks = [0];

    const visibleCues=State.presetEdit ? [] : subtitlePreviewIndex.visibleAtFrame(State.cues,exactFps,currentFrame);
    const byTrack=new Map();
    for(const cue of visibleCues){
      const tk=cue.track||0;
      if(!byTrack.has(tk)) byTrack.set(tk,[]);
      byTrack.get(tk).push(cue);
    }
    for(const tk of tks){
      let cur = [], trk = {};
      if(State.presetEdit){
        const previewText = document.getElementById('tsEditPreviewText')?.value || '田這是一段|範例字幕田\n田 ABC123|321CBA 田';
        cur = [{ id: 'draft_preview', text: previewText, style: {} }];
        trk = State.presetEdit.draft;
      }else{
        cur = byTrack.get(tk)||[];
        if(!cur.length)continue;
        trk=State.tracks[tk]||{};
      }
      const grab = (State.presetEdit || !trk.locked) ? ' drag' : ''; // 草稿可拖，鎖定軌不可拖
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
      const contStyle = `left:${st.posX}%;right:auto;top:${st.posY}%;transform:translate(${-a.x}%,${-a.y}%);text-align:${ta};padding:0;z-index:${100-tk};`;
      let css=styleToCss(st, ratio);
      if(st.shadow<=0) css+='text-shadow:none;';             // 蓋掉 .line class 的預設六向描邊
      if(!st.bgBox) css+='background:transparent;';
      // padding 會把文字往內推 → 與 ASS 錯位（ASS 的 BorderStyle=3 是把色塊往【外】長，文字不動）。
      // 故 substyle.js 在產生 CSS 時已加入等量負 margin 抵銷，色塊往外長、文字位置不動。
      if(collide[i]) css+='color:#ff4444;';                   // 與前一句落在同一點＝會糊在一起
      const inner = escapeHTML(c.text||'').replace(/\n/g,'<br>'); // 直書由 writing-mode 自動分列（多行=多列）
      const vertClass = st.vertical ? ' vertical' : ''; // 直書容器同步套 writing-mode，修正 Chromium 高度少算 Bug
      sig+=tk+'|'+c.id+'|'+contStyle+grab+'|'+collide[i]+'|'+c.text+'|'+JSON.stringify(st)+';';
      html+=`<div class="vsub-track${grab}${vertClass}" data-tk="${tk}" data-cue="${c.id}"`+
        (grab?' title="拖曳＝移動這一句／頂端把手＝旋轉"':'')+` style="${contStyle}">`+
        `<span class="line" style="${css}">${inner}</span>`+
        // 旋轉把手：滑鼠移到該句才浮出（見 styles.css）。放在容器內、隨容器定位，
        // 但【不】隨文字一起轉——轉起來把手會跑掉、抓不住。
        (grab?`<i class="rot" title="拖曳＝旋轉（按住 Shift 吸附 15°）"></i>`:'')+
      `</div>`;
    });
  }
  }catch(err){ console.error('[videoSub] 渲染錯誤（保留上次畫面）:', err); return; } // 防禦②：單次出錯不清空字幕、下次重試
  if(sig===_videoSubSig) { renderImageOverlays(); return; }
  _videoSubSig=sig; _videoSub.innerHTML=html;
  renderImageOverlays();

  // 終極修復 Chromium 直書截斷 Bug 與墨水溢出裁切 Bug：
  // 1. 直書截斷：Chromium 在計算正交排版時，會錯誤地把高度截斷在外層容器 (vsublayer) 的高度。
  // 2. 墨水溢出：純文字的 ascender/descender 經常超出標準行高，導致虛線切字。
  // 完美解法：【維度轉換法】
  // 對於任何中英文與符號，只要字體沒變，它在「橫排」時的寬度，精準等於它在「直排」時的高度！
  // 我們將直排字幕強制解除直排屬性，讓它在一個無限大的容器內以橫排顯示，
  // 這樣 Chromium 完全不會觸發直排截斷 Bug。我們量測其橫排的 offsetWidth / offsetHeight，
  // 並將寬高反轉 (W=H, H=W)，完美精準算出直書時所需的排版空間，徹底打破截斷限制！
  requestAnimationFrame(() => {
    const tracks = Array.from(_videoSub.querySelectorAll('.vsub-track'));
    if(tracks.length === 0) return;

    const measureWrapper = document.createElement('div');
    measureWrapper.style.position = 'fixed';
    measureWrapper.style.top = '0';
    measureWrapper.style.left = '0';
    measureWrapper.style.width = '99999px';
    measureWrapper.style.height = '99999px';
    measureWrapper.style.visibility = 'hidden';
    measureWrapper.style.pointerEvents = 'none';
    document.body.appendChild(measureWrapper);

    const data = [];

    // Pass 1: Clone 並轉換為橫排來測量真實物理尺寸
    tracks.forEach(track => {
      const line = track.querySelector('.line');
      if(!line) return;
      
      const trackClone = track.cloneNode(true);
      // 解除所有旋轉與定位
      trackClone.style.transform = 'none';
      const lineClone = trackClone.querySelector('.line');
      if(lineClone) lineClone.style.transform = 'none';
      
      // 【關鍵】：如果是直排字幕，強制拔除直排屬性，讓它變成橫排！
      const isVertical = track.classList.contains('vertical');
      if(isVertical) {
        trackClone.classList.remove('vertical');
        trackClone.style.writingMode = 'horizontal-tb'; // 確保絕對是橫排
        if(lineClone) {
          lineClone.style.writingMode = 'horizontal-tb';
          lineClone.style.textOrientation = 'mixed';
        }
      }
      
      measureWrapper.appendChild(trackClone);
      
      const style = window.getComputedStyle(lineClone);
      const marginX = (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
      const marginY = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      
      // 讀取橫排時的真實排版尺寸 (已加回 margin，等於純淨的 margin-box)
      const measuredW = lineClone.offsetWidth + marginX;
      const measuredH = lineClone.offsetHeight + marginY;
      
      if(measuredW > 0 && measuredH > 0){
        data.push({
          track: track,
          // 【維度對調】：直排時，高度 = 橫排寬度；寬度 = 橫排高度
          w: isVertical ? measuredH : measuredW,
          h: isVertical ? measuredW : measuredH
        });
      }
    });

    document.body.removeChild(measureWrapper);

    // Pass 2: 將反轉後的真實尺寸寫回，徹底打破 Chromium 截斷限制
    data.forEach(item => {
      item.track.style.width = item.w + 'px';
      item.track.style.height = item.h + 'px';
    });
  });

  // 重繪會換掉原本的 DOM 節點；拖曳中直接接回新節點，讓原生提示框跟著位置走，
  // 非拖曳時則清掉過期的 hover 引導，等下一次指標移動再計算。
  if(_hoveredSubEl && !_hoveredSubEl.isConnected){
    const dragEl=previewDrag.subtitleDrag()?.cue ? _videoSub.querySelector(`.vsub-track.drag[data-cue="${previewDrag.subtitleDrag().cue.id}"]`) : null;
    _setSubtitleHover(dragEl||null);
  }
}


let _mpvImageGuideSig = '';

/* 圖片原始尺寸（contain 之後才知道互動框要多大）。匯入時已寫進 clip.natW/natH，
   舊專案／還原路徑可能沒有 → 這裡以 src 為鍵背景量一次再補寫回 clip 並重繪。 */
const _imgNatCache = new Map();
function _imageNat(c, src){
  if(c.natW > 0 && c.natH > 0) return { w:c.natW, h:c.natH };
  if(!src) return { w:0, h:0 };
  const hit = _imgNatCache.get(src);
  if(hit&&hit.ownsMedia()){
    if(hit.w > 0){ c.natW = hit.w; c.natH = hit.h; }
    if(!hit.retryReady) return hit;
  }
  const ownsMedia=Media.captureMediaOwnership();
  const entry={w:0,h:0,ownsMedia,attempt:hit?.ownsMedia() ? hit.attempt+1 : 0, retryReady:false};
  _imgNatCache.set(src,entry); // 佔位：避免每一格都重新發一次請求
  const probe = new Image();
  const retry=()=>{
    if(!ownsMedia() || _imgNatCache.get(src)!==entry) return;
    // 暫時無法讀取時不永久快取失敗，也不能在播放每幀重試；暫停時仍可復原。
    const delay=Math.min(30000,1000*2**Math.min(entry.attempt,5));
    setTimeout(()=>{
      if(!ownsMedia() || _imgNatCache.get(src)!==entry){
        if(_imgNatCache.get(src)===entry) _imgNatCache.delete(src);
        return;
      }
      entry.retryReady=true;
      if(State.clips.some(clip=>imageSourceUrl(clip)===src)) renderImageOverlays();
    },delay);
  };
  probe.onload = () => {
    if(!ownsMedia() || _imgNatCache.get(src)!==entry){
      if(_imgNatCache.get(src)===entry) _imgNatCache.delete(src);
      return;
    }
    const w = probe.naturalWidth || 0, h = probe.naturalHeight || 0;
    if(!(w > 0 && h > 0)){ retry(); return; }
    entry.w=w;entry.h=h;
    if(w > 0){
      const live=Seq.byId(c.id);
      if(live&&imageSourceUrl(live)===src&&!(live.natW>0&&live.natH>0)){
        live.natW=w;live.natH=h;
      }
    }
    renderImageOverlays();
  };
  probe.onerror = retry;
  setMediaElementSource(probe,src);
  return { w:0, h:0 };
}

/* clip 的圖片來源 URL（純檔案路徑才補 legacy file:///；opaque capability URL 一律照用） */
function _imageSrc(c){
  return imageSourceUrl(c);
}
/* 圖片在畫框內的實際矩形；拖曳與渲染共用，避免兩邊各算一次而漂移 */
export function _imageBoxOf(c, rect){
  const nat = _imageNat(c, _imageSrc(c));
  return imageBoxOnStage({
    stageW: rect.w, stageH: rect.h, track: State.videoTracks[c.vtrack || 0] || {},
    natW: nat.w, natH: nat.h, scale: c.scale ?? 1, posX: c.posX ?? 0.5, posY: c.posY ?? 0.5,
  });
}

export function renderImageOverlays(){
  const rect = _stageRect();
  const layer = document.getElementById('imageLayer');
  if(!layer) return;
  if(!rect){
    layer.innerHTML='';
    layer._imageHtml='';
    if(_mpvImageGuideSig && getPlayerAdapter().setImageGuide){
      _mpvImageGuideSig='';
      getPlayerAdapter().setImageGuide(null).catch(()=>{});
    }
    return;
  }
  
  const key = rect.x+'|'+rect.y+'|'+rect.w+'|'+rect.h;
  if(layer.dataset.rect !== key){
    layer.dataset.rect = key;
    const st = layer.style;
    st.left=rect.x+'px'; st.top=rect.y+'px';
    st.width=rect.w+'px'; st.height=rect.h+'px';
    st.right='auto'; st.bottom='auto'; st.margin='0';
    st.aspectRatio='auto'; st.maxWidth='none'; st.maxHeight='none';
  }

  const composition=Media.previewComposition?.();
  const t=composition?.time??Media.displayTime();
  const imagesComposited=!!composition?.imagesComposited;
  // mixed stack 在 decode/proxy 準備期間也只准由 compositor 出圖；不能把
  // 下層圖片暫時搬到 native/HTML 影片之上。操作框仍由主 renderer 保留。
  const bitmapInCanvas=imagesComposited||visualStackPlan(Seq.clipsAt(t),State.videoTracks).mixedImages;
  // 只處理 type === 'image' 且 trackVisible 的
  const imageClips = Seq.clipsAt(t).filter(c => Seq.isStill(c) && videoTrackVisible(c.vtrack || 0));
  
  let html = '';
  // MPV 的原生畫面在主 DOM 上方，圖片外觀交給透明 guide 顯示；互動始終由
  // 這個主 renderer 的 #imageLayer 收到，不能另建第二條 native pointer 路徑。
  imageClips.forEach(c => {
    // 幾何（scale／posX／posY／所在視訊軌的 PiP）由 image-compositor-engine.js 的 imageLayerPlan() 共用 imageBoxOnStage()
    const opacity = (State.videoTracks[c.vtrack || 0]?.opacity ?? 1);

    // image-compositor-engine.js 的 fadeAlphaAtTimeline() 共用 shared/clip-fade.cjs 淡入淡出規格；匯出側套用同一組數字。
    const alpha = Math.max(0, Math.min(1, opacity * fadeAlphaAtTimeline(c, t)));

    const imgSrc = _imageSrc(c);

    /* 互動框＝圖片【實際被畫出來的那塊】（見 image-compositor-engine.js 的 imageLayerPlan()）。
       舊版直接把「scale×畫框」當成 .img-wrap，非 16:9 的素材會讓虛線框與四角把手
       離圖片本體上百 px，下緣兩顆還會掉到播放列底下＝拉不到、也移不準。 */
    const nat=_imageNat(c,imgSrc);
    const {box,frame,visible}=imageLayerPlan({stageW:rect.w,stageH:rect.h,
      track:State.videoTracks[c.vtrack||0],clip:c,natW:nat.w,natH:nat.h,time:t});
    const crop=[Math.max(0,frame.y-box.y),Math.max(0,box.x+box.w-frame.x-frame.w),
      Math.max(0,box.y+box.h-frame.y-frame.h),Math.max(0,frame.x-box.x)];
    const contStyle = `left:${box.x.toFixed(2)}px; top:${box.y.toFixed(2)}px; width:${box.w.toFixed(2)}px; height:${box.h.toFixed(2)}px; opacity:${alpha};`;
    /* 把手吸附回【畫面內】：圖片被放大到超出畫框時，四角會跑到看不見的地方，
       使用者就再也縮不回來（只剩右鍵數值面板可救）。這裡把把手夾在
       「圖片 ∩ 畫框」的可見矩形四角，圖片完全在框內時與貼齊四角等價。 */
    const HS = 10; // 把手邊長，需與 styles.css / MPV_GUIDE_HTML 一致
    const visL = Math.min(Math.max(0, visible.x-box.x), Math.max(0, box.w - HS));
    const visT = Math.min(Math.max(0, visible.y-box.y), Math.max(0, box.h - HS));
    const visR = Math.max(Math.min(box.w, visible.x+visible.w-box.x), visL + HS);
    const visB = Math.max(Math.min(box.h, visible.y+visible.h-box.y), visT + HS);
    const hPos = (cx, cy) =>
      `left:${(cx === 'w' ? visL : visR - HS).toFixed(1)}px;top:${(cy === 'n' ? visT : visB - HS).toFixed(1)}px;right:auto;bottom:auto;`;
    // 被選取的圖片留下操作框，讓使用者能一眼辨識目前可拖曳／縮放的素材。
    const selected = c.id === State.selectedClipId || previewDrag.imageDrag()?.clip?.id === c.id;
    html += `<div class="img-wrap${selected ? ' selected' : ''}" data-id="${c.id}" style="${contStyle}">
      <img draggable="false" crossorigin="anonymous" src="${escapeHTML(imgSrc)}" style="visibility:${bitmapInCanvas?'hidden':'visible'};clip-path:inset(${crop.map(v=>v.toFixed(2)+'px').join(' ')});" />
      <div class="resize-handle rh-nw" data-corner="nw" style="${hPos('w','n')}"></div>
      <div class="resize-handle rh-ne" data-corner="ne" style="${hPos('e','n')}"></div>
      <div class="resize-handle rh-sw" data-corner="sw" style="${hPos('w','s')}"></div>
      <div class="resize-handle rh-se" data-corner="se" style="${hPos('e','s')}"></div>
    </div>`;
  });
  
  // file:/// URL 會被瀏覽器正規化；直接比較 innerHTML 會誤判成不同並在每一格重建圖片
  // 節點，進而中斷 pointer capture。保留最後輸出的字串才能讓縮放拖曳連續。
  if(layer._imageHtml !== html){
    layer.innerHTML = html;
    layer._imageHtml = html;
  }

  const guideSig = Media.mpvPresenting()
    ? `${rect.x}|${rect.y}|${rect.w}|${rect.h}|${html}`
    : '';
  if(Media.mpvPresenting() && getPlayerAdapter().setImageGuide){
    // [效能與字體最佳化] 
    // 當處於 MPV 原生播放模式時，為了避免強行切換 WebCodecs 造成 CPU 解碼卡頓，
    // 以及避免從 MPV libass 字幕渲染切換至 HTML DOM 造成字幕視覺大小突變，
    // 我們將圖片疊加層 (包含 rect 座標) 傳送至 Electron mpv-host 所有的透明置頂 guide 視窗。
    // 這樣即可在維持 MPV GPU 硬體加速與原生字幕渲染的同時，將圖片完美顯示在畫面上方。
    // 原生 guide 是另一個 BrowserWindow；只在內容變更時更新，避免播放中每格重寫 DOM。
    if(_mpvImageGuideSig !== guideSig){
      _mpvImageGuideSig = guideSig;
      getPlayerAdapter().setImageGuide({ html, rect }).catch(()=>{});
    }
  } else if(getPlayerAdapter().setImageGuide){
    if(_mpvImageGuideSig){
      _mpvImageGuideSig = '';
      getPlayerAdapter().setImageGuide(null).catch(()=>{});
    }
  }
}



export function _selectImageClip(clip, { redrawTimeline=true }={}){
  if(!clip || State.videoTracks[clip.vtrack || 0]?.locked) return false;
  setSelection({ kind:'video', ids:clip.id });
  refreshSelectionUI();
  const label = $('stSel'); if(label) label.textContent = '已選圖片：' + (clip.name || '未命名圖片');
  // pointerdown 中同步重建整個時間軸會延後 pointer capture；先讓預覽開始拖曳，
  // 放開時再重繪時間軸的選取狀態即可。
  if(redrawTimeline) drawTimeline();
  return true;
}

/* 軌道樣式改動後的統一重繪：預覽畫面／mpv 字幕／樣式面板／字幕列表的樣式摘要。
   ── 一律走這裡（v4.29.5）：這四處本來各自散在九個呼叫點，漏掉列表摘要 → 面板改了框線、
      座標，列表卻還顯示舊值（要等別的操作觸發整份重繪才會補上，看起來像「只有某些欄位會更新」）。 */
export const previewDrag = createPreviewDrag({
  getStageRect: _stageRect,
  selectImageClip: _selectImageClip,
  renderImageOverlays,
  renderVideoSub,
  drawTimeline,
  recordHistory,
  beginPreview:(targets,owns,cancel)=>History.beginPreview(targets,owns,cancel),
  imageBoxOf: _imageBoxOf,
  getPresetEdit: () => State.presetEdit,
  refreshMpvSubs,
  selectCueSingle,
  setSubtitleHover: _setSubtitleHover,
  renderTrackStyle: () => emit('render:trackStyle'),
  refreshStyleSummaries: () => emit('render:styleSummaries'),
  onSubDragEndCleanup: (pointerId, d) => {
    const restoreMpvSubs = _mpvSubtitleDrag;
    _mpvSubtitleDrag = false;
    _videoSub.classList.remove('dragging');
    try { _videoSub.releasePointerCapture(pointerId); } catch(err) {}
    if(restoreMpvSubs){
      _videoSub.classList.add('mpv-hit-layer');
      refreshMpvSubs(true);
    } else {
      refreshMpvSubs();
    }
  }
});
previewDrag.bind({ imageLayer: typeof document !== 'undefined' ? document.getElementById('imageLayer') : null, videoSub: _videoSub, videoWrap: _videoWrap });

/* ==============================================================================
   播放器全螢幕與媒體視圖事件控制
   ============================================================================== */

export function initMediaView() {
  on('media:audioTracks', renderAudioTracks);
  on('media:timeline',    drawTimeline);
  on('media:clearMeters',  clearMeterStrips);
  on('media:playhead',     updatePlayhead);
  on('media:srcSel',       renderSrcSel);
}

function loadCaptureImage(url){
  return new Promise((resolve,reject)=>{
    const image=new Image();
    image.onload=()=>resolve(image);
    image.onerror=()=>reject(new Error('無法載入截圖影像'));
    setMediaElementSource(image,url);
  });
}

// The snapshot owns its canvas and image plan before any save-dialog or file
// allocation awaits. Callers do not select a hidden playback adapter themselves.
export async function capturePreviewFrame({nativePath,readBase64}={}){
  const preview=$('previewCanvas');
  const previewVisible=preview&&getComputedStyle(preview).display!=='none'&&getComputedStyle(preview).visibility!=='hidden';
  const composition=previewVisible?Media.previewComposition?.():null;
  const canvasSetting=State.projectCanvas;
  const canvasSize=projectCanvasSize();
  const width=composition?.width||canvasSize.width,height=composition?.height||canvasSize.height;
  const hasCanvas=previewVisible&&preview.width&&preview.height&&(!Media.inGap()||composition);
  const time=composition?.time??Media.displayTime(),fps=State.fps,dropFrame=State.dropFrame;
  const videoDarkness=Math.max(0,Math.min(1,Media.previewFadeDarkness()));
  const stack=visualStackPlan(Seq.clipsAt(time).filter(c=>videoTrackVisible(c.vtrack||0)),State.videoTracks);
  const images=stack.images
    .map(c=>({clip:{...c},track:{...State.videoTracks[c.vtrack||0]},src:_imageSrc(c)}));
  const topVideo=stack.videos.at(-1);
  const videoLayer=topVideo?{clip:{...topVideo},track:{...State.videoTracks[topVideo.vtrack||0]}}:null;
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#000';ctx.fillRect(0,0,width,height);
  let presenter='black',sourceFrame=null;
  if(!hasCanvas&&!Media.inGap()&&Media.mpvPresenting()){
    if(!nativePath||!readBase64) throw new Error('原生播放器截圖沒有儲存目錄');
    // FPS-SYNC：凍結的 TC／圖片計畫必須對應同一張 native 畫格。
    // 呈現 owner 等該時間確認後才取圖，讀入像素前持續停住 presenter；
    // 換來源或較新的 seek 會撤銷取圖資格，不得保存遲到的舊圖。
    await Media.withPresentedFrame(time,async({adapter,isCurrent})=>{
      const check=()=>{if(!isCurrent()||State.projectCanvas!==canvasSetting) throw Object.assign(new Error('截圖已被較新的播放或畫布設定取代'),{name:'AbortError'});};
      check();
      const result=await adapter.screenshot(nativePath);
      check();
      if(!result||result.ok===false) throw new Error('原生播放器截圖失敗');
      if(Object.hasOwn(result,'projectCanvas') &&
        (result.projectCanvas?.width!==canvasSetting?.width || result.projectCanvas?.height!==canvasSetting?.height))
        throw new Error('專案畫布仍在更新，請稍後重試截圖');
      // Native JPEG already contains ASS, including subtitles in canvas padding.
      // Rebuilding a mixed-image stack from its cropped content would lose those
      // subtitles. The ready compositor path above captures the complete canvas.
      if(canvasSetting && result.contentRect && stack.mixedImages)
        throw new Error('合成預覽尚未就緒，請待合成畫面顯示後再截圖');
      const b64=typeof result.b64==='string'?result.b64:await readBase64(nativePath);
      check();
      if(!b64) throw new Error('無法讀取原生播放器截圖');
      const image=await loadCaptureImage('data:image/jpeg;base64,'+b64);
      check();
      sourceFrame=image;
      const rect=stageBox({canvasW:width,canvasH:height,projectW:image.naturalWidth||image.width,projectH:image.naturalHeight||image.height});
      ctx.drawImage(image,rect.x,rect.y,rect.w,rect.h);presenter='mpv';
    });
  }else if(hasCanvas||!Media.inGap()){
    if(hasCanvas){
      const rect=stageBox({canvasW:preview.width,canvasH:preview.height,projectW:width,projectH:height});
      ctx.drawImage(preview,rect.x,rect.y,rect.w,rect.h,0,0,width,height);presenter='webcodecs';
    }else if(video&&(video.currentSrc||video.getAttribute('src'))
      &&getComputedStyle(video).visibility!=='hidden'&&getComputedStyle(video).display!=='none'){
      // 無影片來源的圖片／純音訊時間軸保留黑底合成，不要求不存在的影片畫格。
      // displayTime 可先反映尚在解碼的 seek；等可見 HTML presenter 證明目標格，
      // 才能把實際像素與上方凍結的時間、圖片計畫配成同一張截圖。
      await Media.withPresentedFrame(time,({isCurrent})=>{
        if(!isCurrent()) throw Object.assign(new Error('截圖已被較新的播放操作取代'),{name:'AbortError'});
        if(video.readyState<2) throw new Error('HTML 播放器尚未提供截圖畫格');
        const rect=stageBox({canvasW:width,canvasH:height,projectW:video.videoWidth||width,projectH:video.videoHeight||height});
        sourceFrame=document.createElement('canvas');sourceFrame.width=video.videoWidth||width;sourceFrame.height=video.videoHeight||height;
        sourceFrame.getContext('2d').drawImage(video,0,0,sourceFrame.width,sourceFrame.height);
        ctx.save();ctx.globalAlpha=stack.mixedImages?1:1-videoDarkness;
        ctx.drawImage(sourceFrame,rect.x,rect.y,rect.w,rect.h);ctx.restore();presenter='html5';
      });
    }
  }
  // 畫布與 ownership 在第一個 await 前一起凍結。held frame 的圖片與幾何已在
  // physical canvas 裡，不能再拿目前時間軸的新圖片重疊一次。
  if(presenter==='webcodecs'&&composition&&(composition.imagesComposited||stack.mixedImages)) return {canvas,time,fps,dropFrame,presenter};
  const paintImage=async layer=>{
    const image=await loadCaptureImage(layer.src);
    const {box,frame,alpha}=imageLayerPlan({stageW:width,stageH:height,track:layer.track,
      clip:layer.clip,natW:layer.clip.natW||image.naturalWidth,natH:layer.clip.natH||image.naturalHeight,time});
    ctx.save();ctx.beginPath();ctx.rect(frame.x,frame.y,frame.w,frame.h);ctx.clip();
    ctx.globalAlpha=alpha;ctx.drawImage(image,box.x,box.y,box.w,box.h);ctx.restore();
  };
  if(stack.mixedImages&&videoLayer&&presenter!=='black'){
    const frame=document.createElement('canvas');frame.width=width;frame.height=height;
    frame.getContext('2d').drawImage(canvas,0,0,width,height);
    ctx.fillStyle='#000';ctx.fillRect(0,0,width,height);
    const below=images.filter(layer=>(layer.clip.vtrack||0)<=(videoLayer.clip.vtrack||0));
    for(const layer of below) await paintImage(layer);
    const {box,frame:track,alpha}=imageLayerPlan({stageW:width,stageH:height,track:videoLayer.track,
      clip:videoLayer.clip,natW:videoLayer.clip.natW||width,natH:videoLayer.clip.natH||height,time});
    ctx.save();ctx.beginPath();ctx.rect(track.x,track.y,track.w,track.h);ctx.clip();
    if(presenter==='webcodecs'){
      // Video-only compositor already placed its picture; preserve that rectangle.
      ctx.drawImage(frame,track.x,track.y,track.w,track.h,track.x,track.y,track.w,track.h);
    }else{
      // Native/HTML fallback is one source frame; place it between the frozen images.
      ctx.globalAlpha=alpha;
      ctx.drawImage(sourceFrame||frame,box.x,box.y,box.w,box.h);
    }
    ctx.restore();
    for(const layer of images.filter(layer=>!below.includes(layer))) await paintImage(layer);
  }else{
    for(const layer of images) await paintImage(layer);
  }
  return {canvas,time,fps,dropFrame,presenter};
}

function renderSrcSel() {
  const sel = $('waveSrcSel'); if (!sel) return;
  const activeSrcId = Media.activeSource || 'video';
  const matching = Wave.sources.map((s, i) => ({ s, i }))
      .filter(x => (x.s.sourceId || 'video') === activeSrcId);
  const show = matching.length > 1;
  sel.innerHTML = matching.map(x =>
    `<option value="${x.i}">${escapeHTML(String(x.s.label ?? ''))}</option>`
  ).join('');
  if (!matching.find(x => x.i === Wave.srcIdx) && matching.length > 0) {
    Wave.selectSource(matching[0].i);
  }
  sel.value = String(Math.max(0, Wave.srcIdx));
  sel.style.display = show ? '' : 'none';
}

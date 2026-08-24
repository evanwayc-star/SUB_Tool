import { $, video, tlScroll, tlLayer } from './dom.js';
import { State, isSel, setSelection, deselect, IS_DESKTOP, saveConfig, trackVisible, videoTrackVisible } from './state.js';
import { Media } from './media.js';

import { Seq } from './sequence.js';
import { emit, on } from './events.js';
import { getExactFps, secToEncore } from './time.js';
import { effStyle, styleToCss, ASS_PLAY_RES, anchorPct } from './substyle.js';
import { escapeHTML } from './util.js';
import { getPlayerAdapter } from './media-player-adapter.js';
import { toASSFromState } from './subio.js';
import { createPreviewDrag } from './pointer-interaction.js';
import { drawTimeline } from './timeline.js';
import { imageBoxOnStage } from './image-geometry.js';
import { fadeAlphaAtTimeline } from './clip-fade.js';
import { renderASS } from './ass-render.js';
import { measureSubtitleBackgroundLayouts } from './subtitle-background-layout.js';
import { recordHistory } from './history.js';
import { showToast, setMpvWindowVisible } from './ui.js';
import { refreshSelectionUI, selectCueSingle } from './subtitles.js';

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
/* mpv 是 OS 層子視窗，無法被 HTML z-index 蓋過。
   只在浮動面板/搜尋視窗「實際重疊」影片區域時才隱藏 mpv，不重疊時影片繼續顯示。 */
export function _syncMpvPanel(){
  /* 守衛看的是【mpv 視窗這條 IPC 通不通】，不是「現在裝的是哪個 adapter」——
     兩者會脫鉤，詳見 ui.js setMpvWindowVisible 的註解。 */
  if(!Media.mpvMode || !window.subtool?.mpv) return;
  // 對話框比照浮動面板：只有【真的蓋到影片區】才讓位。keepVideo 的對話框（編輯字幕文字）
  // 靠右停、不重疊 → mpv 續留，編輯時看得到畫面（v4.33.2；否則 openModal 的 keepVideo 會被這裡蓋掉）
  const _mb=$('modalBg');
  let modalOpen=false;
  if(_mb?.classList.contains('show')){
    const mEl=_mb.querySelector('.modal'), vr0=$('videoWrap')?.getBoundingClientRect();
    const mr=mEl?.getBoundingClientRect();
    modalOpen = !(mr && vr0) || !(mr.right<=vr0.left||mr.left>=vr0.right||mr.bottom<=vr0.top||mr.top>=vr0.bottom);
  }
  // 快捷鍵設定是獨立於 modalBg 的自訂對話框（settings.js 自建 #settingsModal），
  // 同樣會被 mpv 蓋住，開啟期間一律讓位
  const settingsOpen=!!document.getElementById('settingsModal');
  // 序列間隙（時間軸上無影片的區段）：畫面應為黑 → mpv 讓位
  // WC 接管（proxy 就緒、WebCodecs 合成呈現中）：mpv 視窗一律讓位（僅供時鐘＋聲音兜底）
  let hides=modalOpen||settingsOpen||Media.inGap()||Media.webCodecsTakeover();
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
      if(!hides){
        /* 工具列的下拉選單（.menu.open .items）。這一條是 v6.1.9 補的。

           真實事故：「最近開啟」展開後有最多 10 筆、每筆兩行，高度遠超過工具列，
           直接伸進影片區。選單有正確 render（CDP 量到 computed style 可見、每一列
           的 getBoundingClientRect 都有寬高）卻【完全看不到】——因為 mpv 是 OS 層
           子視窗，HTML 的 z-index 蓋不過它。

           §0.7 說可見性只能看 computed style，那是對的；但它只證明「HTML 這一層
           把它畫出來了」，證明不了「使用者的眼睛看得到」。上面那幾種疊層（浮動面板、
           搜尋視窗、右鍵選單）早就接進這裡了，只有工具列選單從一開始就漏掉——
           先前沒有人發現，是因為在這之前工具列選單都很矮，撐不到影片區。 */
        for(const it of document.querySelectorAll('.menu.open .items')){
          if(ov(it.getBoundingClientRect())){hides=true;break;}
        }
      }
    }
  }
  setMpvWindowVisible(!hides);
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
/* 影片畫面在 videoWrap 內的實際顯示區（contain）。字幕層對齊它 ——
   否則字幕框固定 16:9，遇到不同比例的片（2.39:1 電影 vs 16:9）畫面高度不同，
   字幕卻照同一個框換算 →「字幕大小在各個影片上不一樣」。回 null＝取不到來源尺寸。 */
/* 畫面【實際被畫出來的那塊】——字幕層、安全框、圖片層、拖曳換算全部以它為基準。
   #video 是 object-fit:contain，所以顯示區是「來源比例貼合 videoWrap 後」的內縮矩形。

   基準必須是【來源的真實尺寸】，不能寫死 16:9：
   匯出畫布用的是 State.videoWidth/Height（見 subio.js），mpv 也照真實畫面。
   這裡若假設 16:9，2.35:1 的素材會讓預覽的字級相對畫面高放大約 32%，
   而 posY=91% 在預覽落在黑邊上、匯出卻在畫面內——三路一致（§0.1）當場破功。

   State.videoWidth/Height 兩條開檔路徑都會設：原生走 media.js:752（video.videoWidth）、
   mpv／ffmpeg 走 media.js:874（ffprobe 的 info.video）。取不到才退回 16:9，
   那是「還沒載入任何影片」的空專案情境。 */
const STAGE_FALLBACK_W = 1920, STAGE_FALLBACK_H = 1080;
export function _stageRect(){
  if(!_videoWrap) return null;
  const W = _videoWrap.clientWidth, H = _videoWrap.clientHeight;
  if(!W || !H) return null;
  const srcW = +State.videoWidth || 0, srcH = +State.videoHeight || 0;
  const vw = srcW > 0 ? srcW : STAGE_FALLBACK_W;
  const vh = srcH > 0 ? srcH : STAGE_FALLBACK_H;
  const s = Math.min(W/vw, H/vh);
  const dw = Math.max(1, Math.round(vw*s)), dh = Math.max(1, Math.round(vh*s));
  return { x: Math.round((W-dw)/2), y: Math.round((H-dh)/2), w: dw, h: dh };
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
export function renderVideoSub(){
  drawSafeFrame(); // 安全框跟著畫面每幀對齊
  renderTimecodeWatermark(); // 同步播放器監看時間碼（不參與輸出）
  // 【雙引擎渲染架構說明 (v5.2.0)】
  // 1. 單軌影片 (MPV): mpv.exe 是一個 OS 層級實體視窗 (HWND)，會像一塊黑布一樣完全蓋住底下的 Chrome DOM。
  //    因此，單軌時「必須」依賴 MPV 內建的 C++ libass 引擎，直接將字幕畫在影片上。此時 HTML DOM 僅保留透明命中層供拖曳。
  // 2. 多軌影片 (WebCodecs): MPV 無法進行複雜即時混圖，因此會被隱藏。此時改用 HTML canvas (WCPreview) 渲染畫面，
  //    字幕也就「必須」改由 HTML DOM (#videoSub) 繪製，因為 libass 已經跟著 MPV 被隱藏了。
  // 3. 尺寸對齊: 透過 substyle.js 的 ASS_PLAY_RES 鎖定 1920x1080 與 0.75 (72/96) 字體係數，
  //    確保 HTML DOM 與 libass 的字體在像素級別達到數學上的 100% 一致。
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

    for(const tk of tks){
      let cur = [], trk = {};
      if(State.presetEdit){
        const previewText = document.getElementById('tsEditPreviewText')?.value || '田這是一段|範例字幕田\n田 ABC123|321CBA 田';
        cur = [{ id: 'draft_preview', text: previewText, style: {} }];
        trk = State.presetEdit.draft;
      }else{
        cur = State.cues.filter(c => {
          if ((c.track||0)!==tk || c.timed===false) return false;
          const startFrame = Math.round(c.start * exactFps);
          const endFrame = Math.round(c.end * exactFps);
          return currentFrame >= startFrame && currentFrame < endFrame;
        });
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
  const hit = _imgNatCache.get(src);
  if(hit){ if(hit.w > 0){ c.natW = hit.w; c.natH = hit.h; } return hit; }
  _imgNatCache.set(src, { w:0, h:0 }); // 佔位：避免每一格都重新發一次請求
  const probe = new Image();
  probe.onload = () => {
    const w = probe.naturalWidth || 0, h = probe.naturalHeight || 0;
    _imgNatCache.set(src, { w, h });
    if(w > 0){ const live = Seq.byId(c.id); if(live){ live.natW = w; live.natH = h; } }
    renderImageOverlays();
  };
  probe.onerror = () => {};
  probe.src = src;
  return { w:0, h:0 };
}

/* clip 的圖片來源 URL（純檔案路徑才補 legacy file:///；opaque capability URL 一律照用） */
function _imageSrc(c){
  let src = c.web?.url || c.path || '';
  if(src && !/^(https?|file|blob|data|subtool-local):/i.test(src)) src = 'file:///' + src.replace(/\\/g, '/');
  return src;
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

  const t = Media.displayTime();
  // 只處理 type === 'image' 且 trackVisible 的
  const imageClips = Seq.clipsAt(t).filter(c => c.type === 'image' && videoTrackVisible(c.vtrack || 0));
  
  let html = '';
  // MPV 的原生畫面在主 DOM 上方，圖片外觀交給透明 guide 顯示；互動始終由
  // 這個主 renderer 的 #imageLayer 收到，不能另建第二條 native pointer 路徑。
  imageClips.forEach(c => {
    // 幾何（scale／posX／posY／所在視訊軌的 PiP）一律走 _imageBoxOf → image-geometry.js
    const opacity = (State.videoTracks[c.vtrack || 0]?.opacity ?? 1);

    // 淡入淡出的長度、斜坡與時間域轉換只有 clip-fade.js 一份規格；匯出側套用同一組數字。
    const alpha = Math.max(0, Math.min(1, opacity * fadeAlphaAtTimeline(c, t)));

    const imgSrc = _imageSrc(c);

    /* 互動框＝圖片【實際被畫出來的那塊】（見 image-geometry.js）。
       舊版直接把「scale×畫框」當成 .img-wrap，非 16:9 的素材會讓虛線框與四角把手
       離圖片本體上百 px，下緣兩顆還會掉到播放列底下＝拉不到、也移不準。 */
    const box = _imageBoxOf(c, rect);
    const contStyle = `left:${box.x.toFixed(2)}px; top:${box.y.toFixed(2)}px; width:${box.w.toFixed(2)}px; height:${box.h.toFixed(2)}px; opacity:${alpha};`;
    /* 把手吸附回【畫面內】：圖片被放大到超出畫框時，四角會跑到看不見的地方，
       使用者就再也縮不回來（只剩右鍵數值面板可救）。這裡把把手夾在
       「圖片 ∩ 畫框」的可見矩形四角，圖片完全在框內時與貼齊四角等價。 */
    const HS = 10; // 把手邊長，需與 styles.css / MPV_GUIDE_HTML 一致
    const visL = Math.min(Math.max(0, -box.x), Math.max(0, box.w - HS));
    const visT = Math.min(Math.max(0, -box.y), Math.max(0, box.h - HS));
    const visR = Math.max(Math.min(box.w, rect.w - box.x), visL + HS);
    const visB = Math.max(Math.min(box.h, rect.h - box.y), visT + HS);
    const hPos = (cx, cy) =>
      `left:${(cx === 'w' ? visL : visR - HS).toFixed(1)}px;top:${(cy === 'n' ? visT : visB - HS).toFixed(1)}px;right:auto;bottom:auto;`;
    // 被選取的圖片留下操作框，讓使用者能一眼辨識目前可拖曳／縮放的素材。
    const selected = c.id === State.selectedClipId || previewDrag.imageDrag()?.clip?.id === c.id;
    html += `<div class="img-wrap${selected ? ' selected' : ''}" data-id="${c.id}" style="${contStyle}">
      <img draggable="false" src="${escapeHTML(imgSrc)}" />
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
previewDrag.bind({ imageLayer: document.getElementById('imageLayer'), videoSub: _videoSub, videoWrap: _videoWrap });

export {
  computePreviewViewport, computeSafeFrameBounds, computeScaledFontSize
} from './video-overlay-compositor.js';


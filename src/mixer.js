/* SUB Tool — 音軌列表 + 混音器（逐聲道電平表 / 獨奏 / 靜音 / 音源切換） */
import { $ } from './dom.js';
import { escapeHTML } from './util.js';
import { Media } from './media.js';

function renderAudioTracks(){
  const list=$('atList'); list.innerHTML='';
  const real=Media.tracks.filter(t=>t.kind==='buffer'||t.kind==='native'||t.kind==='nativeTrack'||t.kind==='element');
  // 準備中的占位推桿屬於影片音源；切到外部音源檢視時不顯示
  const _showPending=(Media.activeSource===null||Media.activeSource==='video');
  const pending=_showPending?(Media.pendingChannels||[]).filter(c=>!c.ready):[];
  if(real.length===0 && pending.length===0){ $('atHint').textContent='尚未載入音訊'; if($('mixerPanel')&&$('mixerPanel').classList.contains('show'))renderMixer(); return; }
  $('atHint').textContent=(real.length+pending.length)+' 條音軌'+(pending.length?'（準備中…）':'');
  for(const tr of real){
    const row=document.createElement('div');row.className='atrack';
    row.innerHTML=
      `<span class="nm">${escapeHTML(tr.name)}</span>`+
      `<button class="mini mute ${tr.muted?'on':''}" title="${tr.muted?'取消靜音':'靜音'}">M</button>`+
      `<button class="mini solo ${tr.solo?'on':''}" title="${tr.solo?'取消獨奏':'獨奏'}">S</button>`+
      `<input type="range" min="0" max="1.5" step="0.01" value="${tr.volume}">`;
    const [muteBtn,soloBtn]=row.querySelectorAll('button');
    const vol=row.querySelector('input');
    muteBtn.onclick=()=>{tr.muted=!tr.muted;Media.applyGains();renderAudioTracks();};
    soloBtn.onclick=()=>{tr.solo=!tr.solo;Media.applyGains();renderAudioTracks();};
    vol.oninput=()=>{tr.volume=+vol.value;Media.applyGains();};
    list.appendChild(row);
  }
  for(const pc of pending){
    const row=document.createElement('div');row.className='atrack pending';
    row.innerHTML=`<span class="nm">${escapeHTML(pc.label)}</span><span class="prep"><span class="spin"></span>準備中</span>`;
    list.appendChild(row);
  }
  renderAudioSources();
  if($('mixerPanel')&&$('mixerPanel').classList.contains('show'))renderMixer();
}

function renderAudioSources(){
  const src=Media.activeSource;
  const sel=$('mixerSrcSel');
  const selWave=$('waveGlobalSrcSel');
  if(!sel && !selWave) return;
  const srcs=Media.getSources();
  const updateSel = (sNode) => {
    if(!sNode)return;
    if(srcs.length===0){ sNode.innerHTML='<option value="">(無音源)</option>'; sNode.disabled=true; }
    else {
      sNode.innerHTML='';
      for(const s of srcs){
        const opt=document.createElement('option');
        opt.value=s.id; opt.textContent=s.label;
        if(s.id===src) opt.selected=true;
        sNode.appendChild(opt);
      }
      sNode.disabled=false;
    }
  };
  updateSel(sel); updateSel(selWave);
}

/* ===== 混音器：逐聲道電平表 + 獨奏/靜音（浮動面板） ===== */
let _meterStrips=[];
function renderMixer(){
  const wrap=$('mixerStrips'); if(!wrap)return;
  _meterStrips=[];
  const src=Media.activeSource;

  const real=Media.tracks.filter(t=>{
    if(!(t.kind==='buffer'||t.kind==='native'||t.kind==='element'))return false;
    if(src!==null&&(t.source||'video')!==src)return false;
    return true;
  });
  const _showPending=(Media.activeSource===null||Media.activeSource==='video');
  const pending=_showPending?(Media.pendingChannels||[]).filter(c=>!c.ready):[];
  if(!real.length && !pending.length){ wrap.innerHTML='<div class="empty" style="padding:14px;white-space:nowrap">尚無音訊聲道</div>'; return; }
  wrap.innerHTML='';
  for(const tr of real){
    const strip=document.createElement('div'); strip.className='mx-strip';
    const vol=Math.round((tr.volume==null?1:tr.volume)*100);
    strip.innerHTML=
      `<div class="mx-meter"><div class="mx-mask"></div><div class="mx-peak"></div>`+
        `<input class="mx-fader" type="range" min="0" max="100" step="1" value="${vol}" title="音量 ${vol}%">`+
      `</div>`+
      `<div class="mx-name" title="${escapeHTML(tr.name)}">${escapeHTML(tr.name)}</div>`+
      `<div class="mx-btns">`+
        `<button class="mx-solo${tr.solo?' on':''}" title="${tr.solo?'取消獨奏':'獨奏'}">S &nbsp;獨奏</button>`+
        `<button class="mx-mute${tr.muted?' on':''}" title="${tr.muted?'取消靜音':'靜音'}">M &nbsp;靜音</button>`+
      `</div>`;
    const fader=strip.querySelector('.mx-fader');
    fader.oninput=()=>{ tr.volume=(+fader.value)/100; fader.title='音量 '+fader.value+'%'; Media.applyGains(); };
    fader.addEventListener('mousedown',e=>e.stopPropagation()); // 不要觸發面板拖移
    strip.querySelector('.mx-solo').onclick=()=>{ tr.solo=!tr.solo; Media.applyGains(); renderMixer(); renderAudioTracks(); };
    strip.querySelector('.mx-mute').onclick=()=>{ tr.muted=!tr.muted; Media.applyGains(); renderMixer(); renderAudioTracks(); };
    wrap.appendChild(strip);
    _meterStrips.push({tr, mask:strip.querySelector('.mx-mask'), peak:strip.querySelector('.mx-peak')});
  }
  for(const pc of pending){
    const strip=document.createElement('div'); strip.className='mx-strip pending';
    strip.innerHTML=
      `<div class="mx-meter"><div class="mx-prep"><span class="spin"></span></div></div>`+
      `<div class="mx-name" title="${escapeHTML(pc.label)}">${escapeHTML(pc.label)}</div>`+
      `<div class="mx-btns"><div class="mx-preplabel">準備中…</div></div>`;
    wrap.appendChild(strip);
  }
}
function _mixerTracks(){
  const src=Media.activeSource;
  return Media.tracks.filter(t=>{
    if(!(t.kind==='buffer'||t.kind==='native'||t.kind==='element'))return false;
    if(src!==null&&(t.source||'video')!==src)return false;
    return true;
  });
}
function mixerReset(){ for(const t of _mixerTracks()){ t.solo=false; t.muted=false; } Media.applyGains(); renderMixer(); renderAudioTracks(); }
function mixerMuteAll(){ for(const t of _mixerTracks()){ t.solo=false; t.muted=true; } Media.applyGains(); renderMixer(); renderAudioTracks(); }

function updateMeters(){
  const panel=$('mixerPanel'); if(!panel||!panel.classList.contains('show')||!_meterStrips.length)return;
  const now=performance.now();
  for(const s of _meterStrips){
    const tr=s.tr; let lvl=0;
    if(tr.analyser&&tr._mbuf){
      tr.analyser.getFloatTimeDomainData(tr._mbuf);
      let mx=0; const b=tr._mbuf; for(let i=0;i<b.length;i++){ const v=Math.abs(b[i]); if(v>mx)mx=v; }
      lvl=mx;
    }
    tr.level=Math.max(lvl,(tr.level||0)*0.82); // 平滑衰減
    const db=tr.level>1e-4?20*Math.log10(tr.level):-60;
    const h=Math.max(0,Math.min(100,(db+60)/60*100));
    s.mask.style.height=(100-h)+'%';
    if(h>=(tr._peakH||0)){ tr._peakH=h; tr.peakT=now; }
    else if(now-(tr.peakT||0)>900){ tr._peakH=Math.max(0,(tr._peakH||0)-1.6); }
    s.peak.style.bottom=(tr._peakH||0)+'%';
  }
}

// Fix #10：供 Media.reset() 呼叫，清除過時的音軌參照，避免 rafLoop 讀取廢棄 analyser
function clearMeterStrips(){ _meterStrips=[]; }

export { renderAudioTracks, renderAudioSources, renderMixer, mixerReset, mixerMuteAll, updateMeters, clearMeterStrips };

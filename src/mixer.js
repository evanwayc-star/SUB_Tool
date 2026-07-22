/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/mixer.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
/* SUB Tool — 專案音訊軌混音器（A1…An bus；來源聲道只在配線中處理） */
import { $ } from './dom.js';
import { escapeHTML } from './util.js';
import { State } from './state.js';
import { Media } from './media.js';
import { emit } from './events.js';

function projectBuses(){ return Array.isArray(State.audioProject?.buses)?State.audioProject.buses:[]; }
function busLabel(bus,index){ return `A${index+1}`; }
function busName(bus,index){ return bus?.name||busLabel(bus,index); }
function busVolume(bus){ return Math.max(0,Math.min(1.5,Number(bus?.volume==null?1:bus.volume)||0)); }

/* 與 timeline 的 bus 控制共用同一個通知介面：Media 負責重新套 gain，
   timeline 則依 DOM event 更新列與波形。拖曳音量時只即時更新 gain，放開後才完整重繪。 */
function notifyBusChange(bus,field,value,{live=false}={}){
  const detail={busId:bus?.id,bus,field,value};
  emit('audio:busChanged',detail);
  if(live){ Media.applyGains(); return; }
  if(typeof window!=='undefined'&&typeof window.CustomEvent==='function'){
    window.dispatchEvent(new CustomEvent('audio-project:bus-change',{detail}));
  }else Media.applyGains();
}
function recordBusHistory(action,bus,index){ emit('history:record',`${action}：${busLabel(bus,index)}`); }
function refreshBusViews(){
  renderAudioTracks();
  if($('mixerPanel')?.classList.contains('show')) renderMixer();
}

function bindBusRow(row,bus,index){
  const mute=row.querySelector('.mute');
  const solo=row.querySelector('.solo');
  const volume=row.querySelector('input[type=range]');
  mute.onclick=()=>{
    bus.muted=!bus.muted;
    notifyBusChange(bus,'muted',bus.muted);
    recordBusHistory(bus.muted?'靜音音訊軌':'取消靜音音訊軌',bus,index);
    refreshBusViews();
  };
  solo.onclick=()=>{
    bus.solo=!bus.solo;
    notifyBusChange(bus,'solo',bus.solo);
    recordBusHistory(bus.solo?'獨奏音訊軌':'取消獨奏音訊軌',bus,index);
    refreshBusViews();
  };
  let committed=busVolume(bus);
  volume.addEventListener('mousedown',event=>event.stopPropagation());
  volume.oninput=()=>{
    bus.volume=(+volume.value)/100;
    volume.title='音量 '+volume.value+'%';
    notifyBusChange(bus,'volume',bus.volume,{live:true});
  };
  volume.addEventListener('change',()=>{
    const next=busVolume(bus);
    if(Math.abs(next-committed)<=0.00001) return;
    notifyBusChange(bus,'volume',next);
    recordBusHistory('調整音訊軌音量',bus,index);
    committed=next;
    refreshBusViews();
  });
}

function renderAudioTracks(){
  const list=$('atList'); if(!list)return;
  list.innerHTML='';
  const buses=projectBuses();
  const hint=$('atHint');
  const countInput=$('projectAudioTracksCount');
  if(countInput && document.activeElement !== countInput) countInput.value = buses.length;
  if(!buses.length){
    if(hint) hint.textContent='尚未建立專案音訊軌';
    renderAudioSources();
    if($('mixerPanel')?.classList.contains('show')) renderMixer();
    return;
  }
  if(hint) hint.textContent=`${buses.length} 條專案音訊軌`;
  buses.forEach((bus,index)=>{
    const label=busLabel(bus,index), name=busName(bus,index), volume=Math.round(busVolume(bus)*100);
    const row=document.createElement('div'); row.className='atrack project-bus';
    row.dataset.busId=String(bus.id||'');
    row.innerHTML=
      `<span class="nm" title="${escapeHTML(name)}"><b>${label}</b>${name!==label?` · ${escapeHTML(name)}`:''}</span>`+
      `<button class="mini mute ${bus.muted?'on':''}" title="${bus.muted?'取消靜音':'靜音'} ${label}">M</button>`+
      `<button class="mini solo ${bus.solo?'on':''}" title="${bus.solo?'取消獨奏':'獨奏'} ${label}">S</button>`+
      `<input type="range" min="0" max="150" step="1" value="${volume}" title="音量 ${volume}%">`;
    bindBusRow(row,bus,index);
    list.appendChild(row);
  });
  renderAudioSources();
  if($('mixerPanel')?.classList.contains('show')) renderMixer();
}

/* 浮動混音器不再以 Media source 切換為控制面；wave 的來源選擇仍保留，
   因為它只影響波形監看而非 project bus 的 M/S/volume。 */
function renderAudioSources(){
  const mixerSelect=$('mixerSrcSel');
  if(mixerSelect){
    mixerSelect.innerHTML='<option value="">專案輸出音訊軌</option>';
    mixerSelect.disabled=true;
    mixerSelect.title='混音器控制的是專案輸出音訊軌（A1…An）';
  }
  const waveSelect=$('waveGlobalSrcSel');
  if(!waveSelect)return;
  const source=Media.activeSource;
  const sources=Media.getSources();
  if(!sources.length){ waveSelect.innerHTML='<option value="">(無音源)</option>'; waveSelect.disabled=true; return; }
  waveSelect.innerHTML='';
  const all=document.createElement('option'); all.value='__all__'; all.textContent='全部混音'; all.selected=source===null; waveSelect.appendChild(all);
  for(const item of sources){
    const option=document.createElement('option'); option.value=item.id; option.textContent=item.label;
    option.selected=item.id===source; waveSelect.appendChild(option);
  }
  waveSelect.disabled=false;
}

/* ===== 混音器：每條 strip 對應一條 project bus ===== */
let _meterStrips=[];
function renderMixer(){
  const wrap=$('mixerStrips'); if(!wrap)return;
  _meterStrips=[];
  const buses=projectBuses();
  if(!buses.length){ wrap.innerHTML='<div class="empty" style="padding:14px;white-space:nowrap">尚未建立專案音訊軌</div>'; return; }
  wrap.innerHTML='';
  buses.forEach((bus,index)=>{
    const label=busLabel(bus,index), name=busName(bus,index), volume=Math.round(busVolume(bus)*100);
    const strip=document.createElement('div'); strip.className='mx-strip project-bus';
    strip.dataset.busId=String(bus.id||'');
    strip.innerHTML=
      `<div class="mx-meter"><div class="mx-mask"></div><div class="mx-peak"></div>`+
        `<input class="mx-fader" type="range" min="0" max="150" step="1" value="${volume}" title="音量 ${volume}%">`+
      `</div>`+
      `<div class="mx-name" title="${escapeHTML(name)}">${label}${name!==label?` · ${escapeHTML(name)}`:''}</div>`+
      `<div class="mx-btns">`+
        `<button class="mx-solo${bus.solo?' on':''}" title="${bus.solo?'取消獨奏':'獨奏'} ${label}">S &nbsp;獨奏</button>`+
        `<button class="mx-mute${bus.muted?' on':''}" title="${bus.muted?'取消靜音':'靜音'} ${label}">M &nbsp;靜音</button>`+
      `</div>`;
    const fader=strip.querySelector('.mx-fader');
    let committed=busVolume(bus);
    fader.oninput=()=>{
      bus.volume=(+fader.value)/100;
      fader.title='音量 '+fader.value+'%';
      notifyBusChange(bus,'volume',bus.volume,{live:true});
    };
    fader.addEventListener('mousedown',event=>event.stopPropagation());
    fader.addEventListener('change',()=>{
      const next=busVolume(bus);
      if(Math.abs(next-committed)<=0.00001) return;
      notifyBusChange(bus,'volume',next);
      recordBusHistory('調整音訊軌音量',bus,index);
      committed=next;
      refreshBusViews();
    });
    strip.querySelector('.mx-solo').onclick=()=>{
      bus.solo=!bus.solo;
      notifyBusChange(bus,'solo',bus.solo);
      recordBusHistory(bus.solo?'獨奏音訊軌':'取消獨奏音訊軌',bus,index);
      refreshBusViews();
    };
    strip.querySelector('.mx-mute').onclick=()=>{
      bus.muted=!bus.muted;
      notifyBusChange(bus,'muted',bus.muted);
      recordBusHistory(bus.muted?'靜音音訊軌':'取消靜音音訊軌',bus,index);
      refreshBusViews();
    };
    wrap.appendChild(strip);
    _meterStrips.push({bus,mask:strip.querySelector('.mx-mask'),peak:strip.querySelector('.mx-peak'),level:0,peakH:0,peakT:0});
  });
}

function _busRouteTracks(bus){
  const busId=String(bus?.id||'');
  if(!busId)return [];
  const anyTrackSolo=Media.tracks.some(track=>track.solo&&!track._srcHidden);
  const anyBusSolo=projectBuses().some(item=>item.solo);
  if(bus.muted||(anyBusSolo&&!bus.solo)) return [];
  return Media.tracks.filter(track=>{
    if(track._srcHidden||!track.analyser||!track.audioSourceId) return false;
    if(anyTrackSolo?!track.solo:track.muted) return false;
    const route=State.audioProject?.sourceMaps?.[track.audioSourceId]?.channels?.find(item=>
      item.sourceStream===track.sourceStream&&item.sourceChannel===track.sourceChannel
    );
    return !!(route&&route.enabled!==false&&Array.isArray(route.busIds)&&route.busIds.some(id=>String(id)===busId));
  });
}
function _trackLevel(track){
  try{
    if(!track._mbuf) track._mbuf=new Float32Array(track.analyser.fftSize||1024);
    track.analyser.getFloatTimeDomainData(track._mbuf);
    let max=0; for(const sample of track._mbuf){ const value=Math.abs(sample); if(value>max)max=value; }
    return max;
  }catch(e){ return 0; }
}

function mixerReset(){
  const buses=projectBuses();
  const changed=buses.some(bus=>bus.solo||bus.muted);
  for(const bus of buses){ bus.solo=false; bus.muted=false; }
  if(changed){ notifyBusChange(null,'reset',true); emit('history:record','重設專案音訊軌混音'); }
  refreshBusViews();
}
function mixerMuteAll(){
  const buses=projectBuses();
  const changed=buses.some(bus=>bus.solo||!bus.muted);
  for(const bus of buses){ bus.solo=false; bus.muted=true; }
  if(changed){ notifyBusChange(null,'muteAll',true); emit('history:record','靜音所有專案音訊軌'); }
  refreshBusViews();
}

function updateMeters(){
  const panel=$('mixerPanel'); if(!panel||!panel.classList.contains('show')||!_meterStrips.length)return;
  const now=performance.now();
  for(const strip of _meterStrips){
    const busGain=busVolume(strip.bus);
    let level=0;
    for(const track of _busRouteTracks(strip.bus)) level=Math.max(level,_trackLevel(track)*(track.volume==null?1:track.volume)*busGain);
    strip.level=Math.max(level,(strip.level||0)*0.82);
    const db=strip.level>1e-4?20*Math.log10(strip.level):-60;
    const height=Math.max(0,Math.min(100,(db+60)/60*100));
    strip.mask.style.height=(100-height)+'%';
    if(height>=(strip.peakH||0)){ strip.peakH=height; strip.peakT=now; }
    else if(now-(strip.peakT||0)>900){ strip.peakH=Math.max(0,(strip.peakH||0)-1.6); }
    strip.peak.style.bottom=(strip.peakH||0)+'%';
  }
}

// 供 Media.reset() 呼叫，清除過時的 bus/DOM 參照。
function clearMeterStrips(){ _meterStrips=[]; }

export { renderAudioTracks, renderAudioSources, renderMixer, mixerReset, mixerMuteAll, updateMeters, clearMeterStrips };


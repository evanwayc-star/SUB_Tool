/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/mixer.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
   專業級 DAW 調音台通道條 (Channel Strip)，支援立體聲雙電平表、Peak Hold、
   Clipping 削波指示與推子 dB 刻度（聲道由使用者配置指定，無額外聲像回中）。
============================================================================== */
/* SUB Tool — 專案音訊軌混音器（A1…An bus；來源聲道只在配線中處理） */
import { $ } from './dom.js';
import { escapeHTML } from './util.js';
import { State, ensureAudioBusCount } from './state.js';
import { Media } from './media.js';
import { emit } from './events.js';
import { showToast } from './ui.js';

function projectBuses(){
  let buses = Array.isArray(State.audioProject?.buses) ? State.audioProject.buses : [];
  if (!buses.length && (Media.tracks?.length || State.clips?.length)) {
    const chCount = Math.max(1, Media.tracks?.length || 1);
    ensureAudioBusCount(chCount);
    buses = State.audioProject?.buses || [];
  }
  return buses;
}
function busLabel(bus,index){ return `A${index+1}`; }
function busName(bus,index){ return bus?.name||busLabel(bus,index); }
function busVolume(bus){ return Math.max(0,Math.min(4.0,Number(bus?.volume==null?1:bus.volume)||0)); }
function busPan(bus){ return Math.max(-1,Math.min(1,Number(bus?.pan==null?0:bus.pan)||0)); }

/**
 * 將增益值 (0~1.5) 換算為分貝字串 (dB)
 */
function volumeToDbText(volume) {
  if (!volume || volume <= 0.001) return '-∞ dB';
  const db = 20 * Math.log10(volume);
  if (Math.abs(db) < 0.05) return '0.0 dB';
  return (db > 0 ? '+' : '') + db.toFixed(1) + ' dB';
}

/**
 * 將電平值 (0~1+) 換算為電平表分貝讀數
 */
function levelToDbText(level) {
  if (!level || level <= 1e-4) return '-∞';
  const db = 20 * Math.log10(level);
  if (db > 0) return '+' + db.toFixed(1);
  return db.toFixed(1);
}

/* bus 的 M／S／音量變動後通知下游。live=true（拖曳推桿中）只套增益、不發事件——
   每次 input 都重畫整條時間軸太貴。事件的訂閱端與來由見 docs/開發與驗證.md 的事件表。 */
function notifyBusChange(bus,field,value,{live=false}={}){
  if(live){ Media.applyGains(); return; }
  emit('audio:busChanged',{busId:bus?.id,bus,field,value});
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
    volume.title='音量 '+volume.value+'% ('+volumeToDbText(bus.volume)+')';
    notifyBusChange(bus,'volume',bus.volume,{live:true});
  };
  volume.addEventListener('dblclick', () => {
    const input = prompt(`請輸入 ${busLabel(bus,index)} 的音量 dB（例：-6、0、+2；或 +=1.5、-=2）：`, volumeToDbText(busVolume(bus)));
    if (input !== null) {
      applyDbStringToBus(bus, input, index);
    }
  });
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
  if(hint && Media.audioPanelNotice){
    hint.textContent=Media.audioPanelNotice;
    hint.classList.add('audio-capability-notice');
    hint.hidden=false;
  }else if(hint){
    hint.classList.remove('audio-capability-notice');
    hint.hidden=true;
  }
  if(!buses.length){
    if(hint && !Media.audioPanelNotice) hint.textContent='尚未建立專案音訊軌';
    renderAudioSources();
    if($('mixerPanel')?.classList.contains('show')) renderMixer();
    return;
  }
  if(hint && !Media.audioPanelNotice) hint.textContent=`${buses.length} 條專案音訊軌`;
  buses.forEach((bus,index)=>{
    const label=busLabel(bus,index), name=busName(bus,index), volume=Math.round(busVolume(bus)*100);
    const row=document.createElement('div'); row.className='atrack project-bus';
    row.dataset.busId=String(bus.id||'');
    row.innerHTML=
      `<span class="nm" title="${escapeHTML(name)}"><b>${label}</b>${name!==label?` · ${escapeHTML(name)}`:''}</span>`+
      `<button class="mini mute ${bus.muted?'on':''}" title="${bus.muted?'取消靜音':'靜音'} ${label}">M</button>`+
      `<button class="mini solo ${bus.solo?'on':''}" title="${bus.solo?'取消獨奏':'獨奏'} ${label}">S</button>`+
      `<input type="range" min="0" max="200" step="1" value="${volume}" title="音量 ${volume}% (${volumeToDbText(volume/100)}，雙擊輸入 dB)">`;
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

/* ===== 專業混音器：每條 strip 對應一條 project bus ===== */
let _meterStrips=[];
function renderMixer(){
  const wrap=$('mixerStrips'); if(!wrap)return;
  _meterStrips=[];
  const buses=projectBuses();
  if(!buses.length){ wrap.innerHTML='<div class="empty" style="padding:18px 24px;text-align:center;color:#71717a;white-space:nowrap">尚未建立專案音訊軌</div>'; return; }
  wrap.innerHTML='';

  // 同步工具列按鈕狀態（讓使用者一眼看見狀態與功能反映）
  const muteAllBtn = document.querySelector('button[data-act="mixer-muteall"]');
  if (muteAllBtn) {
    const allMuted = buses.length > 0 && buses.every(b => b.muted);
    muteAllBtn.textContent = allMuted ? '🔊 取消靜音' : '🔇 全靜音';
    muteAllBtn.title = allMuted ? '取消所有音訊軌靜音' : '將所有音訊軌靜音';
    muteAllBtn.classList.toggle('on', allMuted);
  }

  buses.forEach((bus,index)=>{
    const label=busLabel(bus,index), name=busName(bus,index);
    const volume=Math.round(busVolume(bus)*100);
    const faderDb=volumeToDbText(volume/100);

    const strip=document.createElement('div');
    strip.className=`mx-strip project-bus ${bus.muted?'is-muted':''}`;
    strip.dataset.busId=String(bus.id||'');

    strip.innerHTML=
      `<div class="mx-strip-head">`+
        `<span class="mx-bus-label">${label}</span>`+
        `<span class="mx-bus-name" title="${escapeHTML(name)}">${escapeHTML(name!==label?name:'')}</span>`+
      `</div>`+
      `<div class="mx-btns-row">`+
        `<button class="mx-btn mx-mute ${bus.muted?'on':''}" title="${bus.muted?'取消靜音':'靜音'} ${label}">M</button>`+
        `<button class="mx-btn mx-solo ${bus.solo?'on':''}" title="${bus.solo?'取消獨奏':'獨奏'} ${label}">S</button>`+
      `</div>`+
      `<div class="mx-meter-fader-area">`+
        `<div class="mx-fader-column">`+
          `<div class="mx-scale mx-fader-scale">`+
            `<span>+6</span><span class="unity">0</span><span>-∞</span>`+
          `</div>`+
          `<div class="mx-fader-track">`+
            `<div class="mx-fader-slot"></div>`+
            `<div class="mx-unity-mark" title="0 dB 基準線"></div>`+
            `<input class="mx-fader" type="range" min="0" max="200" step="1" value="${volume}" title="音量 ${volume}% (${faderDb}，雙擊設為 0 dB)">`+
          `</div>`+
        `</div>`+
        `<div class="mx-meter-column">`+
          `<div class="mx-clip-indicators" title="削波超載指示（點擊重設）">`+
            `<div class="mx-clip-led" title="削波指示"></div>`+
          `</div>`+
          `<div class="mx-dual-meter mx-single-meter">`+
            `<div class="mx-channel-meter">`+
              `<div class="mx-bar-bg"></div>`+
              `<div class="mx-mask"></div>`+
              `<div class="mx-peak"></div>`+
            `</div>`+
          `</div>`+
          `<div class="mx-scale mx-meter-scale">`+
            `<span class="unity">0</span><span>-3</span><span>-6</span><span>-12</span><span>-24</span><span>-∞</span>`+
          `</div>`+
        `</div>`+
      `</div>`+
      `<div class="mx-readout-box mx-readout-row">`+
        `<div class="mx-meter-val" title="即時動態峰值電平">-∞</div>`+
        `<div class="mx-fader-val" title="點擊輸入 dB（例：-6、0、+2；或 +=1.5、-=2），滾輪微調，雙擊回 0 dB">${faderDb}</div>`+
      `</div>`;

    // 1. 綁定推子
    const fader=strip.querySelector('.mx-fader');
    const faderValEl=strip.querySelector('.mx-fader-val');
    let committed=busVolume(bus);

    fader.oninput=()=>{
      const v = (+fader.value) / 100;
      bus.volume = v;
      const dbText = volumeToDbText(v);
      fader.title = `音量 ${fader.value}% (${dbText}，雙擊設為 0 dB)`;
      if (faderValEl) faderValEl.textContent = dbText;
      notifyBusChange(bus,'volume',bus.volume,{live:true});
    };
    fader.addEventListener('mousedown',event=>event.stopPropagation());
    fader.addEventListener('dblclick',()=>{
      // 雙擊推子回歸 0.0 dB (100%)
      fader.value = '100';
      bus.volume = 1.0;
      const dbText = '0.0 dB';
      fader.title = `音量 100% (${dbText}，雙擊設為 0 dB)`;
      if (faderValEl) faderValEl.textContent = dbText;
      notifyBusChange(bus,'volume',1.0);
      recordBusHistory('重設音訊軌音量為 0 dB',bus,index);
      showToast(`${label} 音量已歸零 (0.0 dB)`);
      committed = 1.0;
      refreshBusViews();
    });
    fader.addEventListener('change',()=>{
      const next=busVolume(bus);
      if(Math.abs(next-committed)<=0.00001) return;
      notifyBusChange(bus,'volume',next);
      recordBusHistory('調整音訊軌音量',bus,index);
      committed=next;
      refreshBusViews();
    });

    // 綁定推子讀數點擊輸入 dB、滾輪微調與雙擊回 0 dB
    if (faderValEl) {
      faderValEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (faderValEl.querySelector('input')) return;
        const curVol = busVolume(bus);
        const curDb = curVol <= 0.001 ? -60 : +(20 * Math.log10(curVol)).toFixed(1);

        const origText = faderValEl.textContent;
        const inlineInput = document.createElement('input');
        inlineInput.type = 'text';
        inlineInput.className = 'mx-fader-inline-input';
        inlineInput.value = curDb > -59.9 ? (curDb > 0 ? `+${curDb}` : `${curDb}`) : '-inf';
        inlineInput.title = '輸入目標 dB（例：-6、0、+2）或相對增減（例：+=1.5、-=2）';

        faderValEl.textContent = '';
        faderValEl.appendChild(inlineInput);
        inlineInput.focus();
        inlineInput.select();

        let finished = false;
        const commitEdit = () => {
          if (finished) return;
          finished = true;
          const val = inlineInput.value;
          applyDbStringToBus(bus, val, index);
        };

        inlineInput.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') {
            ke.preventDefault();
            commitEdit();
          } else if (ke.key === 'Escape') {
            ke.preventDefault();
            finished = true;
            faderValEl.textContent = origText;
          }
        });

        inlineInput.addEventListener('blur', () => {
          commitEdit();
        });
      });

      // 滾輪微調 (±0.5 dB)
      faderValEl.addEventListener('wheel', (we) => {
        we.preventDefault();
        we.stopPropagation();
        const step = we.deltaY < 0 ? 0.5 : -0.5;
        const curVol = busVolume(bus);
        const curDb = curVol <= 0.001 ? -60 : 20 * Math.log10(curVol);
        const nextDb = Math.max(-60, Math.min(12, curDb + step));
        const newVol = nextDb <= -59.5 ? 0 : Math.pow(10, nextDb / 20);
        bus.volume = Number(newVol.toFixed(4));
        notifyBusChange(bus, 'volume', bus.volume);
        refreshBusViews();
      }, { passive: false });

      // 雙擊讀數快速回歸 0.0 dB
      faderValEl.addEventListener('dblclick', (de) => {
        de.stopPropagation();
        bus.volume = 1.0;
        notifyBusChange(bus, 'volume', 1.0);
        recordBusHistory('重設音訊軌音量為 0 dB', bus, index);
        showToast(`${label} 音量已歸零 (0.0 dB)`);
        refreshBusViews();
      });
    }

    // 2. 綁定靜音與獨奏
    const muteBtn = strip.querySelector('.mx-mute');
    if (muteBtn) {
      muteBtn.onclick=()=>{
        bus.muted=!bus.muted;
        notifyBusChange(bus,'muted',bus.muted);
        recordBusHistory(bus.muted?'靜音音訊軌':'取消靜音音訊軌',bus,index);
        showToast(bus.muted ? `${label} 已靜音` : `${label} 已取消靜音`);
        refreshBusViews();
      };
    }

    const soloBtn = strip.querySelector('.mx-solo');
    if (soloBtn) {
      soloBtn.onclick=()=>{
        const curBuses = projectBuses();
        bus.solo=!bus.solo;
        notifyBusChange(bus,'solo',bus.solo);
        recordBusHistory(bus.solo?'獨奏音訊軌':'取消獨奏音訊軌',bus,index);
        if (curBuses.length <= 1 && bus.solo) {
          showToast(`${label} 獨奏中（目前僅有單一音軌）`);
        } else {
          showToast(bus.solo ? `${label} 已開啟獨奏` : `${label} 已取消獨奏`);
        }
        refreshBusViews();
      };
    }

    // 4. 削波燈點擊清除
    const clipIndicators = strip.querySelector('.mx-clip-indicators');
    if (clipIndicators) {
      clipIndicators.onclick = () => {
        const stripObj = _meterStrips.find(s => s.bus === bus);
        if (stripObj) {
          stripObj.clipped = false;
          const led = strip.querySelector('.mx-clip-led');
          if (led) led.classList.remove('clip');
          const valEl = strip.querySelector('.mx-meter-val');
          if (valEl) valEl.classList.remove('is-over');
          showToast(`${label} 削波指示已重設`);
        }
      };
    }

    wrap.appendChild(strip);

    _meterStrips.push({
      bus,
      mask: strip.querySelector('.mx-mask'),
      peak: strip.querySelector('.mx-peak'),
      led: strip.querySelector('.mx-clip-led'),
      valEl: strip.querySelector('.mx-meter-val'),
      level: 0,
      peakH: 0,
      peakT: 0,
      clipped: false,
    });
  });
}

/* 電平表的 bus 輸入一律問 Media，不要自己過濾 Media.tracks 或重算 gain。
   這裡以前重寫了一份判定，漏掉外部素材的 placement gain，於是外部音檔被停用時
   表還在跳但沒有聲音。判定與完整增益的家在 project-audio.js
   （由 Media.routedTrackStatesForBus 暴露）。 */
function _busRouteStates(interpretation,bus){
  return interpretation.routedTrackStatesForBus(bus?.id);
}
function _trackLevel(track){
  try{
    if(!track._mbuf) track._mbuf=new Float32Array(track.analyser.fftSize||1024);
    track.analyser.getFloatTimeDomainData(track._mbuf);
    let max=0; for(const sample of track._mbuf){ const value=Math.abs(sample); if(value>max)max=value; }
    return max;
  }catch(e){ return 0; }
}

/**
 * 完整重設混音器（音量推子全部歸零 0 dB，並解除所有靜音與獨奏）
 */
function mixerReset(){
  const buses=projectBuses();
  if(!buses.length){ showToast('尚未建立專案音訊軌'); return; }
  for(const bus of buses){
    bus.solo=false;
    bus.muted=false;
    bus.volume=1.0;
  }
  notifyBusChange(null,'reset',true);
  notifyBusChange(null,'zeroFaders',1.0);
  emit('history:record','重設專案音訊軌混音（推子 0 dB，取消靜音）');
  showToast('混音器已完全重設（推子 0 dB，取消靜音）');
  refreshBusViews();
}

/**
 * 智慧切換全軌靜音／取消靜音
 */
function mixerMuteAll(){
  const buses=projectBuses();
  if(!buses.length){ showToast('尚未建立專案音訊軌'); return; }
  const allMuted = buses.every(bus => bus.muted);
  const nextMuted = !allMuted;
  for(const bus of buses){
    bus.solo=false;
    bus.muted=nextMuted;
  }
  notifyBusChange(null,'muteAll',nextMuted);
  emit('history:record', nextMuted ? '靜音所有專案音訊軌' : '取消靜音所有專案音訊軌');
  showToast(nextMuted ? '已靜音所有音訊軌' : '已取消全軌靜音');
  refreshBusViews();
}

/**
 * 將所有專案音量推子設為 0.0 dB (Unity Gain 1.0)
 */
function mixerZeroFaders(){
  const buses=projectBuses();
  if(!buses.length){ showToast('尚未建立專案音訊軌'); return; }
  for(const bus of buses){
    bus.volume = 1.0;
  }
  notifyBusChange(null,'zeroFaders',1.0);
  emit('history:record','將所有音訊軌音量歸零 (0 dB)');
  showToast('所有音量推子已歸零 (0.0 dB)');
  refreshBusViews();
}

/**
 * 聲像回中（安全相容：使用者已自行設定聲道分配，此處保留為 safe no-op）
 */
function mixerCenterPans(){
  // no-op: 由使用者聲道分配直接決定
}

/**
 * 對個別專案音訊軌解析手動輸入的 dB 字串並套用增益
 * @param {object} bus 目標音訊軌物件
 * @param {string} text 輸入的 dB 字串（例：-6、0、+2；或 +=1.5、-=2；或 -inf）
 * @param {number} [index] 軌道索引（記錄歷史用）
 */
function applyDbStringToBus(bus, text, index = 0){
  if(!bus || text == null) return;
  const raw = String(text).trim().toLowerCase().replace(/db|分貝/g, '').trim();
  if(!raw){ refreshBusViews(); return; }

  const currentVol = busVolume(bus);
  const currentDb = currentVol <= 0.001 ? -60 : 20 * Math.log10(currentVol);
  let targetDb = currentDb;

  if(raw === '-inf' || raw === '-∞' || raw === 'inf' || raw === 'mute'){
    targetDb = -60;
  }else if(raw.startsWith('+=') || raw.startsWith('-=')){
    const delta = parseFloat(raw.slice(2));
    if(!isNaN(delta)){
      targetDb = raw.startsWith('+=') ? currentDb + delta : currentDb - delta;
    }
  }else if(raw.startsWith('+') && !isNaN(parseFloat(raw.slice(1)))){
    // 帶加號視為相對增加 dB
    targetDb = currentDb + parseFloat(raw.slice(1));
  }else if(!isNaN(parseFloat(raw))){
    // 一般數值（例 -6 或 0 或 3）直接設為該目標 dB
    targetDb = parseFloat(raw);
  }else{
    refreshBusViews();
    return;
  }

  targetDb = Math.max(-60, Math.min(12, targetDb));
  const newVol = targetDb <= -59.5 ? 0 : Math.pow(10, targetDb / 20);
  bus.volume = Number(newVol.toFixed(4));

  const dbText = volumeToDbText(bus.volume);
  notifyBusChange(bus, 'volume', bus.volume);
  recordBusHistory(`設定音訊軌音量為 ${dbText}`, bus, index);
  showToast(`${busLabel(bus, index)} 音量已設為 ${dbText}`);
  refreshBusViews();
}

/**
 * 一次對所有專案音訊軌增加或減少音量 dB 數
 * @param {number|string} [deltaInput] 欲增減的 dB 數（例如 +2 增加 2 dB，-3 減少 3 dB）；若未傳入則跳出 prompt
 */
function mixerAdjustAllDb(deltaInput){
  const buses = projectBuses();
  if(!buses.length){ showToast('尚未建立專案音訊軌'); return; }

  let delta = deltaInput;
  if(delta === undefined || delta === null){
    const input = prompt('請輸入要對「所有音訊軌」增加或減少的 dB 數值：\n（例：+2 為全軌增加 2 dB，-3 為全軌減少 3 dB）', '+0.0');
    if(input === null) return;
    const clean = String(input).trim().toLowerCase().replace(/db|分貝/g, '').trim();
    if(!clean) return;
    delta = parseFloat(clean);
  }else{
    delta = Number(delta);
  }

  if(isNaN(delta) || Math.abs(delta) < 0.001) return;

  for(const bus of buses){
    const currentVol = busVolume(bus);
    const currentDb = currentVol <= 0.001 ? -60 : 20 * Math.log10(currentVol);
    const targetDb = Math.max(-60, Math.min(12, currentDb + delta));
    const newVol = targetDb <= -59.5 ? 0 : Math.pow(10, targetDb / 20);
    bus.volume = Number(newVol.toFixed(4));
  }

  notifyBusChange(null, 'adjustAllDb', delta);
  recordBusHistory(`所有音訊軌音量${delta > 0 ? '增加' : '減少'} ${Math.abs(delta)} dB`);
  showToast(`所有音訊軌音量${delta > 0 ? '增加' : '減少'} ${Math.abs(delta)} dB`);
  refreshBusViews();
}

function updateMeters(){
  const panel=$('mixerPanel'); if(!panel||!panel.classList.contains('show')||!_meterStrips.length)return;
  const now=performance.now();
  const interpretation=Media.projectAudioInterpretation();

  for(const strip of _meterStrips){
    let rawLevelL = 0;
    let rawLevelR = 0;
    let hasStereo = false;

    for(const input of _busRouteStates(interpretation,strip.bus)){
      const raw = _trackLevel(input.track) * input.gain;
      const name = String(input.track?.name || '').toUpperCase();
      const ch = input.track?.sourceChannel;

      const isL = name === 'L' || name === 'FL' || ch === 0;
      const isR = name === 'R' || name === 'FR' || ch === 1;

      if(isL && !isR){
        rawLevelL = Math.max(rawLevelL, raw);
        hasStereo = true;
      }else if(isR && !isL){
        rawLevelR = Math.max(rawLevelR, raw);
        hasStereo = true;
      }else{
        rawLevelL = Math.max(rawLevelL, raw);
        rawLevelR = Math.max(rawLevelR, raw);
      }
    }

    if(!hasStereo){
      rawLevelR = rawLevelL;
    }

    // 應用 Pan 聲像增益
    const pan = busPan(strip.bus);
    const panGainL = pan <= 0 ? 1 : Math.cos(pan * Math.PI / 2);
    const panGainR = pan >= 0 ? 1 : Math.cos(-pan * Math.PI / 2);

    const levelL = rawLevelL * panGainL;
    const levelR = rawLevelR * panGainR;
    const maxLevel = Math.max(levelL, levelR);

    // 平滑濾波 (Ballistics: Attack 即時, Decay 緩降)
    strip.level = Math.max(maxLevel, (strip.level || 0) * 0.85);

    // 換算為 dB 與電平柱百分比 (0 dBFS ~ -60 dBFS)
    const db = strip.level > 1e-4 ? 20 * Math.log10(strip.level) : -60;
    const height = Math.max(0, Math.min(100, (db + 60) / 60 * 100));

    // 更新遮罩
    if(strip.mask) strip.mask.style.height = (100 - height) + '%';

    // 峰值保持 (Peak Hold: 停留 900ms 後每幀微降)
    if(height >= (strip.peakH || 0)){ strip.peakH = height; strip.peakT = now; }
    else if(now - (strip.peakT || 0) > 900){ strip.peakH = Math.max(0, (strip.peakH || 0) - 1.6); }
    if(strip.peak) strip.peak.style.bottom = (strip.peakH || 0) + '%';

    // 削波指示燈 (超載 >= 0.999 保持紅燈)
    if(maxLevel >= 0.999){
      strip.clipped = true;
      if(strip.led) strip.led.classList.add('clip');
    }

    // 更新即時數值標籤（超載時顯示紅色高亮警示）
    if(strip.valEl){
      const dbText = levelToDbText(maxLevel);
      strip.valEl.textContent = dbText;
      if(maxLevel >= 0.999){
        strip.valEl.classList.add('is-over');
      }else if(!strip.clipped){
        strip.valEl.classList.remove('is-over');
      }
    }
  }
}

// 供 Media.reset() 呼叫，清除過時的 bus/DOM 參照。
function clearMeterStrips(){ _meterStrips=[]; }

export {
  renderAudioTracks,
  renderAudioSources,
  renderMixer,
  mixerReset,
  mixerMuteAll,
  mixerZeroFaders,
  mixerCenterPans,
  mixerAdjustAllDb,
  applyDbStringToBus,
  updateMeters,
  clearMeterStrips,
};

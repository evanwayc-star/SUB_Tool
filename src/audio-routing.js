/* ==============================================================================
   SUB Tool — 音軌路由與聲道配線模組 (Audio Routing Layer)
   ==============================================================================
   
   【架構與職責總覽】
   本檔案 (audio-routing.js) 負責實作高階影音交付的「多聲道配線盤」。
   將「媒體來源聲道 → 專案單聲道 Bus」及「專案 Bus → 最終匯出 Stream (Mono/Stereo/5.1)」
   分成兩個清楚的抽象層，解決了多機位、多音軌輸入時的複雜混音需求。
   
   1. 純資料與 UI 綁定
      此檔案只處理可序列化的 `State.audioProject` 以及對應的 UI 面板設定。
      實際的 Web Audio API 播放邏輯實作在 `media.js`；
      實際的 FFmpeg 聲道 mapping 匯出實作在 `subio.js`。
      
   2. Delivery Presets (交付預設集)
      預設了業界標準的交片格式 (如 2.0-FM, 5.1-ME 等)，透過 `DELIVERY_PRESETS` 
      將 `MAX_AUDIO_BUSES` 個輸入 Bus 強制映射到對應的輸出 Stream。

   【維護鐵律】
   - 改完 `State.audioProject`（增減 Bus、切換 Layout、改來源→bus 對應）後，必須讓
     `media.js` 重建 Web Audio 連線圖，否則播放會斷音或串音。本檔採**直接呼叫**：
     `AudioPipeline.registerSource(...)` 重建某素材的聲道對應、`Media.applyGains()`
     套用 M/S/音量，再視情況 `renderAudioTracks()` / `drawTimeline()` 重繪。
     ── 不要改用事件：曾有註解要求 `emit('audioRoutingChanged')`，但那個事件
        **從未被 emit、也從未有訂閱者**，照做等於什麼都沒發生（`events.js` 的 emit
        在無 handler 時是靜默 no-op，不會報錯，所以錯得很安靜）。
============================================================================== */
import { State, ensureAudioExportDefaults, normalizeAudioProject } from './state.js';
import { Seq } from './sequence.js';
import { Media } from './media.js';
import { AudioPipeline } from './audio-routing-engine.js';
import { drawTimeline } from './timeline-renderer.js';
import { renderAudioTracks } from './mixer.js';
import { escapeHTML } from './util.js';
import { emit } from './events.js';
import { openModal, closeModal, showToast } from './ui.js';
import { MAX_DELIVERY_AUDIO_BUSES, ensureDeliveryAudioExportDefaults, resizeDeliveryAudioBuses } from './export-job-engine.js';
import { LAYOUTS, MAX_AUDIO_BUSES, DELIVERY_PRESETS, layoutWidth, monoStreamsForBuses, deliveryStreamsForPreset, AudioRoutingModel, resizeProjectAudioBuses } from './audio-routing-engine.js';


function project(){
  State.audioProject=normalizeAudioProject(State.audioProject);
  return State.audioProject;
}
function clipSourceId(clip){
  if(!clip) return null;
  if(clip.id?.startsWith('ext-')) return clip.id;
  return clip.audioSourceId || clip.audioSrc || (clip.primary ? 'video' : ('clip:'+clip.id));
}
function busName(bus,index){ return bus?.name||`A${index+1}`; }
function busById(id){ return project().buses.find(bus=>String(bus.id)===String(id))||null; }
function routeKey(route){ return `${route.sourceStream}:${route.sourceChannel}`; }
function displaySource(route){ return `Stream ${route.sourceStream+1} · Ch ${route.sourceChannel+1}`; }
function updateViews(label){
  Media.applyGains();
  renderAudioTracks();
  drawTimeline();
  emit('history:record',label);
}
function routesForSource(source){
  const sourceId=clipSourceId(source);
  if(!sourceId) return [];
  const existing=project().sourceMaps[sourceId]?.channels;
  if(Array.isArray(existing)&&existing.length) return existing;
  const runtime=Media.tracks.filter(track=>track.audioSourceId===sourceId);
  if(runtime.length){
    AudioPipeline.registerSource(source,runtime.map(track=>({sourceStream:track.sourceStream,sourceChannel:track.sourceChannel})),runtime.length);
    return project().sourceMaps[sourceId]?.channels||[];
  }
  // 外部音檔尚在背景快取時也已有 ffprobe descriptor，不能等到播放節點就緒才讓使用者配線。
  const descriptors=Array.isArray(source?.descriptors) ? source.descriptors : [];
  if(descriptors.length){
    AudioPipeline.registerSource(source,descriptors,descriptors.length);
    return project().sourceMaps[sourceId]?.channels||[];
  }
  return [];
}
function setBusCount(rawCount){
  const transition=resizeProjectAudioBuses(project(),rawCount);
  if(!transition.changed) return false;
  State.audioProject=transition.project;
  return true;
}
function routeTableHtml(clip,routes){
  const buses=project().buses;
  if(!routes.length){
    return `<div class="audio-route-empty">來源音訊仍在分析；完成後會顯示每一條來源聲道。</div>`;
  }
  const rows=routes.map(route=>{
    const selected=(route.busIds||[])[0]||'';
    const opts=['<option value="">— 不輸出 —</option>',...buses.map((bus,index)=>{
      const isSelected=String(bus.id)===String(selected);
      const disabled=bus.locked&&!isSelected?'disabled':'';
      return `<option value="${escapeHTML(bus.id)}" ${isSelected?'selected':''} ${disabled}>${escapeHTML(busName(bus,index))}${bus.locked?'（鎖定）':''}</option>`;
    })].join('');
    return `<tr data-stream="${route.sourceStream}" data-channel="${route.sourceChannel}">
      <td>${escapeHTML(displaySource(route))}</td>
      <td><select class="audio-route-target" data-dirty="0">${opts}</select></td>
      <td class="audio-route-state">${route.enabled!==false&&selected?'已配線':'未配線'}</td>
    </tr>`;
  }).join('');
  return `<div class="audio-route-table-wrap"><table class="audio-route-table">
    <thead><tr><th>來源聲道</th><th>專案音訊軌</th><th>狀態</th></tr></thead><tbody>${rows}</tbody>
  </table></div>`;
}
function syncRouteDraftFromDialog(sourceId){
  const map=project().sourceMaps[sourceId];
  if(!map) return;
  const byKey=new Map(map.channels.map(route=>[routeKey(route),route]));
  document.querySelectorAll('.audio-route-table tbody tr').forEach(row=>{
    const route=byKey.get(`${row.dataset.stream}:${row.dataset.channel}`);
    const select=row.querySelector('.audio-route-target');
    if(!route||!select||select.dataset.dirty!=='1') return;
    const id=select.value||'';
    route.busIds=id?[id]:[];
    route.enabled=!!id;
  });
}
function restoreRouteDraft(sourceId,initialMap){
  const p=project();
  if(initialMap) p.sourceMaps[sourceId]=structuredClone(initialMap);
  else delete p.sourceMaps[sourceId];
  Media.applyGains(); renderAudioTracks(); drawTimeline();
}
function openForRoutingSource(source, originalMap=null){
  if(!source){ showToast('找不到這個音訊來源'); return; }
  const sourceId=clipSourceId(source);
  if(!sourceId){ showToast('此來源沒有可配線的音訊識別'); return; }
  const routes=routesForSource(source);
  const p=project();
  const initialMap=originalMap||structuredClone(p.sourceMaps[sourceId]||null);
  const count=p.buses.length;
  openModal('音訊配線',
    `<div class="audio-route-dialog">
      <div class="audio-route-source"><b>${escapeHTML(source.name||'未命名音訊來源')}</b><span>來源音訊獨立對應至專案總輸出音軌</span></div>
      <div class="audio-bus-count"><label>專案音訊軌數
        <input id="audioBusCount" type="number" min="0" max="${MAX_AUDIO_BUSES}" value="${count}">
      </label><button id="audioBusCountApply" type="button">套用</button>
        <button class="audio-count-preset" type="button" data-count="2">2</button>
        <button class="audio-count-preset" type="button" data-count="4">4</button>
        <button class="audio-count-preset" type="button" data-count="6">6</button>
        <button class="audio-count-preset" type="button" data-count="8">8</button>
        <button class="audio-count-preset" type="button" data-count="10">10</button>
        <button class="audio-count-preset" type="button" data-count="16">16</button>
        <button class="audio-count-preset" type="button" data-count="18">18</button>
      </div>
      <div class="audio-route-actions"><button id="audioRouteAuto" type="button">自動順序對應</button><button id="audioRouteClear" type="button">清除這個來源的配線</button><button id="audioRouteOutput" type="button">輸出聲道設定…</button></div>
      <div class="audio-route-help">例如：來源 Stream 1 · Ch 1–6 可分別指定到 A3–A8。不同影片各自保存自己的分配。</div>
      ${routeTableHtml(source,routes)}
    </div>`,
    [{label:'儲存配線',primary:true,act:()=>{
      syncRouteDraftFromDialog(sourceId);
      closeModal(); updateViews('設定音訊配線：'+(source.name||'音訊來源'));
    }},{label:'取消',act:()=>{ restoreRouteDraft(sourceId,initialMap); closeModal(); }}],{width:'680px'});
  setTimeout(()=>{
    const rerender=()=>openForRoutingSource(source,initialMap);
    const countInput=document.getElementById('audioBusCount');
    document.getElementById('audioBusCountApply')?.addEventListener('click',()=>{ syncRouteDraftFromDialog(sourceId); if(setBusCount(countInput?.value)){ updateViews('調整專案音訊軌數'); rerender(); } });
    document.querySelectorAll('.audio-count-preset').forEach(button=>button.addEventListener('click',()=>{ if(countInput) countInput.value=button.dataset.count||''; syncRouteDraftFromDialog(sourceId); if(setBusCount(button.dataset.count)){ updateViews('調整專案音訊軌數'); rerender(); } }));
    document.querySelectorAll('.audio-route-target').forEach(select=>select.addEventListener('change',()=>{ select.dataset.dirty='1'; }));
    document.getElementById('audioRouteAuto')?.addEventListener('click',()=>{
      const available=project().buses.filter(bus=>!bus.locked);
      document.querySelectorAll('.audio-route-target').forEach((select,index)=>{ select.value=available[index]?.id||''; select.dataset.dirty='1'; });
    });
    document.getElementById('audioRouteClear')?.addEventListener('click',()=>{
      document.querySelectorAll('.audio-route-target').forEach(select=>{ select.value=''; select.dataset.dirty='1'; });
    });
    document.getElementById('audioRouteOutput')?.addEventListener('click',()=>{ syncRouteDraftFromDialog(sourceId); openOutputSettings(()=>openForRoutingSource(source,initialMap)); });
  },0);
}
function openForClip(clipId, originalMap=null){
  const clip=Seq.byId(clipId);
  if(!clip){ showToast('找不到這個影片片段'); return; }
  openForRoutingSource(clip,originalMap);
}
function openForSource(sourceKey, originalMap=null){
  const external=Media.getExternalAudioSource?.(sourceKey);
  if(external){ openForRoutingSource(external,originalMap); return; }
  const clip=Seq.byId(sourceKey)||State.clips.find(item=>clipSourceId(item)===sourceKey);
  if(clip){ openForRoutingSource(clip,originalMap); return; }
  showToast('找不到這個音訊來源');
}
function outputRowHtml(stream,index,buses=project().buses){
  const layout=LAYOUTS[stream.layout]?stream.layout:'mono';
  const width=layoutWidth(layout);
  const firstId=stream.busIds?.[0]||'';
  const starts=buses.map((bus,busIndex)=>({bus,busIndex})).filter(({busIndex})=>busIndex+width<=buses.length);
  const layoutOpts=Object.entries(LAYOUTS).map(([id,info])=>`<option value="${id}" ${id===layout?'selected':''}>${info.label}</option>`).join('');
  const busOpts=['<option value="">— 未指定 —</option>',...starts.map(({bus,busIndex})=>{
    const end=buses[busIndex+width-1];
    const label=width===1?busName(bus,busIndex):`${busName(bus,busIndex)} – ${busName(end,busIndex+width-1)}`;
    return `<option value="${escapeHTML(bus.id)}" ${String(bus.id)===String(firstId)?'selected':''}>${escapeHTML(label)}</option>`;
  })].join('');
  const streamName=String(stream.name||'');
  return `<tr data-stream-id="${escapeHTML(stream.id)}"><td><div class="audio-output-stream"><span class="audio-output-index">${index+1}</span><input class="audio-output-name" aria-label="Stream ${index+1} 名稱" value="${escapeHTML(streamName)}" placeholder="Stream 名稱"></div></td><td><select class="audio-output-layout">${layoutOpts}</select></td><td><select class="audio-output-start">${busOpts}</select></td><td><button type="button" class="audio-output-remove" title="移除此輸出 stream">−</button></td></tr>`;
}
function outputStreamsFromDialog(buses, existingStreams){
  const streams=[];
  const validIds=new Set((existingStreams||[]).map(stream=>String(stream.id)));
  document.querySelectorAll('.audio-output-table tbody tr[data-stream-id]').forEach(row=>{
    const id=row.dataset.streamId;
    if(!validIds.has(String(id))) return;
    const layout=row.querySelector('.audio-output-layout')?.value||'mono';
    const start=row.querySelector('.audio-output-start')?.value||'';
    const startIndex=buses.findIndex(bus=>String(bus.id)===String(start));
    const width=layoutWidth(layout);
    const busIds=startIndex>=0?buses.slice(startIndex,startIndex+width).map(bus=>bus.id):[];
    const name=(row.querySelector('.audio-output-name')?.value||'').trim();
    streams.push({id,layout,busIds,...(name?{name}:{})});
  });
  return streams;
}
/* 目前專案與交付列共用同一個輸出編組 UI；差別只在資料擁有者。這個 adapter 將
   State.audioProject 的既有操作包成 editor，下面的對話框不必知道資料是否為全域專案。 */
function projectOutputEditor(originalLayout=null,originalBusState=null){
  let initial=null;
  ensureAudioExportDefaults({appendMissing:false});
  const p = project();
  initial={
    layout:originalLayout||structuredClone(p.exportLayout),
    buses:originalBusState||structuredClone({mode:p.mode,buses:p.buses})
  };
  
  const model = AudioRoutingModel.createProjectAdapter(State.audioProject);
  
  return {
    prepare(){
      return model.current();
    },
    current(){ return model.current(); },
    /* 草稿寫回 State 時只有【新增 bus】那條路徑需要正規化——bus 的 id 與欄位由
       state.js 的 _normalBus 產生，模型自己捏過一份形狀不同的（v6.1.2 修）。
       其餘幾條刻意【不】呼叫 normalizeAudioProject：它在 exportLayout 為空時會
       自己補上「每條 bus 一個 mono stream」，使用者若把輸出清空就會被自動填回去，
       等於改掉他的編輯結果。模型的 setBusCount 已經在內部正規化過。 */
    setStreams(streams){ model.setStreams(streams); State.audioProject = model.current(); },
    setBusCount(c){ const r = model.setBusCount(c); State.audioProject = model.current(); return r; },
    allMono(){ const r = model.applyAllMonoLayout(); State.audioProject = model.current(); return r; },
    preset(p){ const r = model.applyDeliveryPreset(p); State.audioProject = model.current(); return r; },
    addStream(){ model.addStream(); State.audioProject = model.current(); },
    update:label=>updateViews(label),
    cancel(){
      if(!initial) return;
      const current=project();
      State.audioProject=normalizeAudioProject({
        mode:initial.buses.mode,
        buses:initial.buses.buses,
        sourceMaps:current.sourceMaps,
        exportLayout:initial.layout
      });
      Media.applyGains(); renderAudioTracks(); drawTimeline();
    }
  };
}

/* 每一列交付有自己的 buses / streams。這個 editor 完全不讀也不寫 State，因此改交付
   A 軌數量、取消對話框或同時排多列，不會意外重配正在播放專案的來源聲道。 */
function deliveryOutputEditor(spec){
  let initial=structuredClone(spec||{buses:[],streams:[]});
  let model = AudioRoutingModel.createDeliveryAdapter(initial);
  
  return {
    prepare(){ return model.current(); },
    current(){ return model.current(); },
    setStreams(streams){ model.setStreams(streams); },
    setBusCount(c){ return model.setBusCount(c); },
    allMono(){ 
      const res = model.applyAllMonoLayout(); 
      if(!res) showToast('請先設定至少一條專案音訊軌。'); 
      return res; 
    },
    preset(p){ 
      const res = model.applyDeliveryPreset(p); 
      if(res.error) { showToast(res.error); return false; }
      return true; 
    },
    addStream(){ model.addStream(); },
    syncWavBusIds(){ model.syncWavBusIds(); },
    update(){},
    cancel(){ model = AudioRoutingModel.createDeliveryAdapter(initial); },
    result(){ return model.result(); }
  };
}

function openOutputSettingsEditor(editor,onBack=null,{deliveryFormat=null}={}){
  const p=editor.prepare();
  const wavDelivery=deliveryFormat==='wav';
  const streams=p.exportLayout.streams;
  const rows=streams.map((stream,index)=>outputRowHtml(stream,index,p.buses)).join('')||'<tr><td colspan="4" class="audio-route-empty">尚無可輸出的專案音訊軌。</td></tr>';
  const presetButtons=DELIVERY_PRESETS.map(preset=>{
    let cls = 'audio-delivery-preset';
    if(preset.label.includes('ME')) cls += ' preset-me';
    else if(preset.label.includes('雙語')) cls += ' preset-bi';
    const btn = `<button class="${cls}" type="button" data-preset="${preset.id}" title="${escapeHTML(preset.streams.map(stream=>stream.name).join(' + '))}">${escapeHTML(preset.label)}</button>`;
    if (preset.id === '8-fm') {
      return `<div style="flex-basis:100%;height:0;"></div>` + btn;
    }
    return btn;
  }).join('');
  const outputHelp=wavDelivery
    ? '這份 WAV 會把下列表格選取的專案音訊軌，依表格由上而下的順序寫入同一個多聲道 WAV；未在此列設定過的 WAV 仍會依全部 A 軌順序輸出。'
    : '影片輸出會依下列 Stream mux 音訊；WAV 則固定把所有專案音訊軌依 A 軌順序寫入同一個多聲道 WAV。';
  openModal(wavDelivery?'WAV 音軌設定':'Audio Channel Configuration',
    `<div class="audio-output-dialog">
      <div class="audio-route-help">${outputHelp}</div>
      ${wavDelivery?'':`<div class="audio-bus-count"><label>專案音訊軌數
        <input id="audioOutputBusCount" type="number" min="0" max="${MAX_AUDIO_BUSES}" value="${p.buses.length}">
      </label><button id="audioOutputBusApply" type="button">套用</button>
        <button class="audio-output-count-preset" type="button" data-count="2">2</button>
        <button class="audio-output-count-preset" type="button" data-count="4">4</button>
        <button class="audio-output-count-preset" type="button" data-count="6">6</button>
        <button class="audio-output-count-preset" type="button" data-count="8">8</button>
        <button class="audio-output-count-preset" type="button" data-count="10">10</button>
        <button class="audio-output-count-preset" type="button" data-count="16">16</button>
        <button class="audio-output-count-preset" type="button" data-count="18">18</button>
      </div>`}
      ${wavDelivery
        ? '<div class="audio-delivery-presets"><span>選取要依序寫入這份 WAV 的音軌群組；不會改動專案的 A 軌或來源配線。</span></div>'
        : `<div class="audio-delivery-presets"><span>常用交付配置</span><button id="audioOutputAllMono" type="button">全部Mono(依照專案總軌道數)</button>${presetButtons}</div>`}
      <div class="audio-output-table-wrap"><table class="audio-output-table"><thead><tr><th>${wavDelivery?'WAV 聲道群組':'Stream'}</th><th>${wavDelivery?'群組格式':'Output Channels'}</th><th>Project Channels</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="audio-output-actions"><button id="audioOutputAdd" type="button">＋ 新增 ${wavDelivery?'群組':'Stream'}</button></div>
    </div>`,
    [{label:'儲存輸出設定',primary:true,act:()=>{
      const current=editor.current();
      const busList=current.buses;
      const seen=new Set();
      const next=[];
      let valid=true;
      document.querySelectorAll('.audio-output-table tbody tr[data-stream-id]').forEach(row=>{
        const old=current.exportLayout.streams.find(stream=>stream.id===row.dataset.streamId);
        if(!old) return;
        const layout=row.querySelector('.audio-output-layout')?.value||'mono';
        const start=row.querySelector('.audio-output-start')?.value||'';
        const name=(row.querySelector('.audio-output-name')?.value||'').trim();
        const startIndex=busList.findIndex(bus=>String(bus.id)===String(start));
        const width=layoutWidth(layout);
        const busIds=startIndex>=0?busList.slice(startIndex,startIndex+width).map(bus=>bus.id):[];
        if(busIds.length!==width||busIds.some(id=>seen.has(id))) valid=false;
        busIds.forEach(id=>seen.add(id));
        next.push({id:old.id,layout,busIds,...(name?{name}:{})});
      });
      if(!valid){ showToast(wavDelivery?'每個 WAV 群組需要足夠且不重複的專案音訊軌。':'每個 Stream 需要足夠且不重複的專案音訊軌。'); return; }
      editor.setStreams(next);
      if(wavDelivery) editor.syncWavBusIds?.();
      closeModal(); editor.update('設定輸出音訊聲道');
      if(onBack) onBack({saved:true,spec:editor.result?.()});
    }},{label:onBack?'返回配線':'取消',act:()=>{
      editor.cancel();
      closeModal(); if(onBack) onBack({saved:false});
    }}],{width:'860px'});
  setTimeout(()=>{
    const rerender=()=>{
      // 版面重畫會重新建立「可連續分配」的選項；先保存畫面上的暫存選擇，
      // 才不會在 Mono / Stereo / 5.1 切換時把使用者剛選的編組還原掉。
      const current=editor.current();
      editor.setStreams(outputStreamsFromDialog(current.buses,current.exportLayout.streams));
      openOutputSettingsEditor(editor,onBack,{deliveryFormat});
    };
    const countInput=document.getElementById('audioOutputBusCount');
    document.getElementById('audioOutputBusApply')?.addEventListener('click',()=>{
      const current=editor.current();
      editor.setStreams(outputStreamsFromDialog(current.buses,current.exportLayout.streams));
      if(editor.setBusCount(countInput?.value)){ editor.update('調整專案音訊軌數'); rerender(); }
    });
    document.querySelectorAll('.audio-output-count-preset').forEach(button=>button.addEventListener('click',()=>{
      if(countInput) countInput.value=button.dataset.count||'';
      const current=editor.current();
      editor.setStreams(outputStreamsFromDialog(current.buses,current.exportLayout.streams));
      if(editor.setBusCount(button.dataset.count)){ editor.update('調整專案音訊軌數'); rerender(); }
    }));
    document.getElementById('audioOutputAllMono')?.addEventListener('click',()=>{
      if(!editor.allMono()) return;
      editor.update('設定全部 Mono 輸出');
      openOutputSettingsEditor(editor,onBack,{deliveryFormat});
    });
    document.querySelectorAll('.audio-delivery-preset').forEach(button=>button.addEventListener('click',()=>{
      const preset=DELIVERY_PRESETS.find(item=>item.id===button.dataset.preset);
      if(!preset||!editor.preset(preset)) return;
      editor.update('套用常用輸出配置：'+preset.label);
      openOutputSettingsEditor(editor,onBack,{deliveryFormat});
    }));
    document.querySelectorAll('.audio-output-layout,.audio-output-start').forEach(select=>select.addEventListener('change',()=>{
      // layout 改變時需要重建可選的連續 bus 範圍；只在 layout 欄變動才重畫。
      if(select.classList.contains('audio-output-layout')) rerender();
    }));
    document.querySelectorAll('.audio-output-remove').forEach(button=>button.addEventListener('click',()=>{
      const row=button.closest('tr');
      const rows=[...document.querySelectorAll('.audio-output-table tbody tr[data-stream-id]')];
      if(rows.length<=1){ showToast('至少保留一個輸出 Stream。'); return; }
      row?.remove();
      document.querySelectorAll('.audio-output-table tbody tr[data-stream-id]').forEach((streamRow,index)=>{
        const numberCell=streamRow.querySelector('.audio-output-index');
        if(numberCell) numberCell.textContent=String(index+1);
        const nameInput=streamRow.querySelector('.audio-output-name');
        if(nameInput) nameInput.setAttribute('aria-label',`Stream ${index+1} 名稱`);
      });
    }));
    document.getElementById('audioOutputAdd')?.addEventListener('click',()=>{
      const current=editor.current();
      editor.setStreams(outputStreamsFromDialog(current.buses,current.exportLayout.streams));
      editor.addStream();
      openOutputSettingsEditor(editor,onBack,{deliveryFormat});
    });
  },0);
}

function openOutputSettings(onBack=null, originalLayout=null, originalBusState=null, {deliveryFormat=null}={}){
  openOutputSettingsEditor(projectOutputEditor(originalLayout,originalBusState),onBack,{deliveryFormat});
}
function openDeliveryOutputSettings(spec,onBack=null,{deliveryFormat=null}={}){
  openOutputSettingsEditor(deliveryOutputEditor(spec),onBack,{deliveryFormat});
}

const AudioRouting={openForClip,openForSource,openOutputSettings,openDeliveryOutputSettings,setBusCount};
if(typeof window!=='undefined'){
  window.AudioRouting=AudioRouting;
  window.addEventListener('audio-routing:open',event=>{
    const detail=event?.detail||{};
    if(detail.clipId) openForClip(detail.clipId);
    else if(detail.audioSourceId||detail.sourceId) openForSource(detail.audioSourceId||detail.sourceId);
  });
}

export { AudioRouting };

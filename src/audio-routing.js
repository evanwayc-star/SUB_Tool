/* SUB Tool — 專案音訊配線 UI
   將「媒體來源聲道 → 專案單聲道 bus」及「專案 bus → 匯出 stream」分成兩個清楚的操作面。
   此檔只處理可序列化的 State.audioProject；實際播放與 ffmpeg 匯出各自讀同一份資料。 */
import { State, ensureAudioBusCount, ensureAudioExportDefaults, normalizeAudioProject } from './state.js';
import { Seq } from './sequence.js';
import { Media } from './media.js';
import { drawTimeline } from './timeline.js';
import { renderAudioTracks } from './mixer.js';
import { escapeHTML } from './util.js';
import { emit } from './events.js';
import { openModal, closeModal, showToast } from './ui.js';

const LAYOUTS={
  mono:{label:'Mono',channels:1},
  stereo:{label:'Stereo (L, R)',channels:2},
  stereoLtRt:{label:'Stereo (Lt, Rt)',channels:2},
  '5.1':{label:'5.1 (L, R, C, LFE, Ls, Rs)',channels:6}
};
const MAX_AUDIO_BUSES=1024;
const DELIVERY_PRESETS=[
  {id:'2-fullmix',label:'2 · 2.0 FullMix',count:2,streams:[
    {layout:'stereo',name:'第一語言 2.0 FullMix'}
  ]},
  {id:'4-me',label:'4 · 2.0 + M&E',count:4,streams:[
    {layout:'stereo',name:'第一語言 2.0 FullMix'},
    {layout:'stereo',name:'配音 2.0 M&E'}
  ]},
  {id:'4-bilingual',label:'4 · 雙語 2.0',count:4,streams:[
    {layout:'stereo',name:'第一語言 2.0 FullMix'},
    {layout:'stereo',name:'第二語言 2.0 FullMix'}
  ]},
  {id:'6-fullmix',label:'6 · 5.1 FullMix',count:6,streams:[
    {layout:'5.1',name:'第一語言 5.1 FullMix'}
  ]},
  {id:'8-fullmix',label:'8 · 5.1 + 2.0',count:8,streams:[
    {layout:'5.1',name:'第一語言 5.1 FullMix'},
    {layout:'stereo',name:'第一語言 2.0 FullMix'}
  ]},
  {id:'10-me',label:'10 · 5.1 + 2.0 + M&E',count:10,streams:[
    {layout:'5.1',name:'第一語言 5.1 FullMix'},
    {layout:'stereo',name:'第一語言 2.0 FullMix'},
    {layout:'stereo',name:'配音 2.0 M&E'}
  ]},
  {id:'16-bilingual',label:'16 · 雙語 5.1 + 2.0',count:16,streams:[
    {layout:'5.1',name:'第一語言 5.1 FullMix'},
    {layout:'stereo',name:'第一語言 2.0 FullMix'},
    {layout:'5.1',name:'第二語言 5.1 FullMix'},
    {layout:'stereo',name:'第二語言 2.0 FullMix'}
  ]},
  {id:'18-me',label:'18 · 雙語 + M&E',count:18,streams:[
    {layout:'5.1',name:'第一語言 5.1 FullMix'},
    {layout:'stereo',name:'第一語言 2.0 FullMix'},
    {layout:'5.1',name:'第二語言 5.1 FullMix'},
    {layout:'stereo',name:'第二語言 2.0 FullMix'},
    {layout:'stereo',name:'配音 2.0 M&E'}
  ]}
];

function project(){
  State.audioProject=normalizeAudioProject(State.audioProject);
  return State.audioProject;
}
function clipSourceId(clip){ return clip?.audioSourceId||clip?.audioSrc||null; }
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
    Media.registerAudioRouting(source,runtime.map(track=>({sourceStream:track.sourceStream,sourceChannel:track.sourceChannel})),runtime.length);
    return project().sourceMaps[sourceId]?.channels||[];
  }
  // 外部音檔尚在背景快取時也已有 ffprobe descriptor，不能等到播放節點就緒才讓使用者配線。
  const descriptors=Array.isArray(source?.descriptors) ? source.descriptors : [];
  if(descriptors.length){
    Media.registerAudioRouting(source,descriptors,descriptors.length);
    return project().sourceMaps[sourceId]?.channels||[];
  }
  return [];
}
function setBusCount(rawCount){
  const count=Math.max(0,Math.min(MAX_AUDIO_BUSES,Math.floor(Number(rawCount)||0)));
  const p=project();
  if(count===p.buses.length) return false;
  if(count>p.buses.length){
    p.mode='manual';
    ensureAudioBusCount(count,{appendExportDefaults:true});
    ensureAudioExportDefaults({appendMissing:true});
    return true;
  }
  const removed=p.buses.slice(count);
  const removedIds=new Set(removed.map(bus=>bus.id));
  const usedByRoute=Object.values(p.sourceMaps).some(map=>(map?.channels||[]).some(route=>(route.busIds||[]).some(id=>removedIds.has(id))));
  const usedByExport=(p.exportLayout?.streams||[]).some(stream=>(stream.busIds||[]).some(id=>removedIds.has(id)));
  if(usedByRoute||usedByExport){
    showToast('要減少專案音訊軌前，請先把被使用的 A 軌改派或清除。');
    return false;
  }
  p.mode='manual';
  p.buses=p.buses.slice(0,count);
  ensureAudioExportDefaults({appendMissing:false});
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
      <div class="audio-route-range" aria-label="連續來源聲道對應">
        <span>連續對應</span>
        <label>來源起點 <input id="audioRouteSourceStart" type="number" min="1" value="1"></label>
        <label>A 軌起點 <input id="audioRouteBusStart" type="number" min="1" value="1"></label>
        <label>聲道數 <input id="audioRouteRangeCount" type="number" min="1" value="${Math.max(1,Math.min(routes.length,project().buses.length))}"></label>
        <button id="audioRouteApplyRange" type="button">套用連續對應</button>
      </div>
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
    document.getElementById('audioRouteApplyRange')?.addEventListener('click',()=>{
      const sourceStart=Math.max(1,Math.floor(Number(document.getElementById('audioRouteSourceStart')?.value)||1));
      const busStart=Math.max(1,Math.floor(Number(document.getElementById('audioRouteBusStart')?.value)||1));
      const amount=Math.max(1,Math.floor(Number(document.getElementById('audioRouteRangeCount')?.value)||1));
      const selects=[...document.querySelectorAll('.audio-route-target')];
      const targetBuses=project().buses.slice(busStart-1,busStart-1+amount);
      if(sourceStart-1+amount>selects.length || targetBuses.length!==amount){
        showToast('連續對應的來源聲道或 A 軌範圍不足。');
        return;
      }
      if(targetBuses.some(bus=>bus.locked)){
        showToast('連續對應的 A 軌含有鎖定軌，請先解鎖或改選其他範圍。');
        return;
      }
      for(let index=0;index<amount;index++){
        const select=selects[sourceStart-1+index];
        select.value=targetBuses[index].id;
        select.dataset.dirty='1';
      }
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
function layoutWidth(layout){ return LAYOUTS[layout]?.channels||1; }
function monoStreamsForBuses(buses){
  return buses.map((bus,index)=>({id:`mono-${index+1}`,layout:'mono',name:`A${index+1} Mono`,busIds:[bus.id]}));
}
function deliveryStreamsForPreset(preset,buses){
  let cursor=0;
  return preset.streams.map((spec,index)=>{
    const width=layoutWidth(spec.layout);
    const busIds=buses.slice(cursor,cursor+width).map(bus=>bus.id);
    cursor+=width;
    return {id:`delivery-${preset.id}-${index+1}`,layout:spec.layout,name:spec.name,busIds};
  });
}
function applyDeliveryPreset(preset){
  let p=project();
  const oldLayout=structuredClone(p.exportLayout);
  if(p.buses.length>preset.count){
    // 先替換輸出編組，讓縮減檢查只阻擋仍被來源路由使用的 A 軌。
    p.exportLayout={streams:deliveryStreamsForPreset(preset,p.buses.slice(0,preset.count))};
    if(!setBusCount(preset.count)){
      p.exportLayout=oldLayout;
      return false;
    }
  }else if(p.buses.length<preset.count){
    setBusCount(preset.count);
  }else{
    p.mode='manual';
  }
  // ensureAudioBusCount / ensureAudioExportDefaults 會正規化並換掉 State.audioProject 物件，
  // 因此聲道數改變後必須重新取得目前專案，不能把編組寫進已失效的舊參照。
  p=project();
  p.exportLayout={streams:deliveryStreamsForPreset(preset,p.buses)};
  return true;
}
function applyAllMonoLayout(){
  const p=project();
  if(!p.buses.length){ showToast('請先設定至少一條專案音訊軌。'); return false; }
  p.exportLayout={streams:monoStreamsForBuses(p.buses)};
  return true;
}
function outputRowHtml(stream,index){
  const buses=project().buses;
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
function syncOutputDraftFromDialog(){
  const p=project();
  const buses=p.buses;
  const streams=[];
  document.querySelectorAll('.audio-output-table tbody tr[data-stream-id]').forEach(row=>{
    const id=row.dataset.streamId;
    const layout=row.querySelector('.audio-output-layout')?.value||'mono';
    const start=row.querySelector('.audio-output-start')?.value||'';
    const startIndex=buses.findIndex(bus=>String(bus.id)===String(start));
    const width=layoutWidth(layout);
    const busIds=startIndex>=0?buses.slice(startIndex,startIndex+width).map(bus=>bus.id):[];
    const name=(row.querySelector('.audio-output-name')?.value||'').trim();
    streams.push({id,layout,busIds,...(name?{name}:{})});
  });
  p.exportLayout={streams};
}
function openOutputSettings(onBack=null, originalLayout=null, originalBusState=null){
  let p=project();
  // 只在完全沒有設定時建立 mono 預設。使用者已手動編組後，不能因重新開啟
  // 對話框就把未指定的 A 軌自動補回 mono stream。
  ensureAudioExportDefaults({appendMissing:false});
  p=project();
  const initialLayout=originalLayout||structuredClone(p.exportLayout);
  // 聲道數與交付編組都可在此視窗內變更；取消必須把兩者一起還原，
  // 不能只回復 Stream 表格而留下剛才暫時建立的 A 軌。
  const initialBuses=originalBusState||structuredClone({mode:p.mode,buses:p.buses});
  const streams=p.exportLayout.streams;
  const rows=streams.map(outputRowHtml).join('')||'<tr><td colspan="4" class="audio-route-empty">尚無可輸出的專案音訊軌。</td></tr>';
  const presetButtons=DELIVERY_PRESETS.map(preset=>`<button class="audio-delivery-preset" type="button" data-preset="${preset.id}" title="${escapeHTML(preset.streams.map(stream=>stream.name).join(' + '))}">${escapeHTML(preset.label)}</button>`).join('');
  openModal('Audio Channel Configuration',
    `<div class="audio-output-dialog">
      <div class="audio-route-help">影片輸出會依下列 Stream mux 音訊；WAV 則固定把所有專案音訊軌依 A 軌順序寫入同一個多聲道 WAV。</div>
      <div class="audio-bus-count"><label>專案音訊軌數
        <input id="audioOutputBusCount" type="number" min="0" max="${MAX_AUDIO_BUSES}" value="${p.buses.length}">
      </label><button id="audioOutputBusApply" type="button">套用</button>
        <button class="audio-output-count-preset" type="button" data-count="2">2</button>
        <button class="audio-output-count-preset" type="button" data-count="4">4</button>
        <button class="audio-output-count-preset" type="button" data-count="6">6</button>
        <button class="audio-output-count-preset" type="button" data-count="8">8</button>
        <button class="audio-output-count-preset" type="button" data-count="10">10</button>
        <button class="audio-output-count-preset" type="button" data-count="16">16</button>
        <button class="audio-output-count-preset" type="button" data-count="18">18</button>
      </div>
      <div class="audio-delivery-presets"><span>常用交付配置</span><button id="audioOutputAllMono" type="button">全部 Mono（依上方軌數）</button>${presetButtons}</div>
      <div class="audio-output-table-wrap"><table class="audio-output-table"><thead><tr><th>Stream</th><th>Output Channels</th><th>Project Channels</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="audio-output-actions"><button id="audioOutputAdd" type="button">＋ 新增 Stream</button></div>
    </div>`,
    [{label:'儲存輸出設定',primary:true,act:()=>{
      const busList=project().buses;
      const seen=new Set();
      const next=[];
      let valid=true;
      document.querySelectorAll('.audio-output-table tbody tr[data-stream-id]').forEach(row=>{
        const old=project().exportLayout.streams.find(stream=>stream.id===row.dataset.streamId);
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
      if(!valid){ showToast('每個 Stream 需要足夠且不重複的專案音訊軌。'); return; }
      project().exportLayout.streams=next;
      closeModal(); updateViews('設定輸出音訊聲道');
      if(onBack) onBack();
    }},{label:onBack?'返回配線':'取消',act:()=>{
      const current=project();
      State.audioProject=normalizeAudioProject({
        mode:initialBuses.mode,
        buses:initialBuses.buses,
        sourceMaps:current.sourceMaps,
        exportLayout:initialLayout
      });
      Media.applyGains(); renderAudioTracks(); drawTimeline();
      closeModal(); if(onBack) onBack();
    }}],{width:'700px'});
  setTimeout(()=>{
    const rerender=()=>{
      // 版面重畫會重新建立「可連續分配」的選項；先保存畫面上的暫存選擇，
      // 才不會在 Mono / Stereo / 5.1 切換時把使用者剛選的編組還原掉。
      syncOutputDraftFromDialog();
      openOutputSettings(onBack,initialLayout,initialBuses);
    };
    const countInput=document.getElementById('audioOutputBusCount');
    document.getElementById('audioOutputBusApply')?.addEventListener('click',()=>{
      syncOutputDraftFromDialog();
      if(setBusCount(countInput?.value)){ updateViews('調整專案音訊軌數'); rerender(); }
    });
    document.querySelectorAll('.audio-output-count-preset').forEach(button=>button.addEventListener('click',()=>{
      if(countInput) countInput.value=button.dataset.count||'';
      syncOutputDraftFromDialog();
      if(setBusCount(button.dataset.count)){ updateViews('調整專案音訊軌數'); rerender(); }
    }));
    document.getElementById('audioOutputAllMono')?.addEventListener('click',()=>{
      if(!applyAllMonoLayout()) return;
      updateViews('設定全部 Mono 輸出');
      openOutputSettings(onBack,initialLayout,initialBuses);
    });
    document.querySelectorAll('.audio-delivery-preset').forEach(button=>button.addEventListener('click',()=>{
      const preset=DELIVERY_PRESETS.find(item=>item.id===button.dataset.preset);
      if(!preset||!applyDeliveryPreset(preset)) return;
      updateViews('套用常用輸出配置：'+preset.label);
      openOutputSettings(onBack,initialLayout,initialBuses);
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
      syncOutputDraftFromDialog();
      const used=new Set(project().exportLayout.streams.map(stream=>stream.id));
      let n=1,id='out'+n; while(used.has(id)){ n++; id='out'+n; }
      project().exportLayout.streams.push({id,layout:'mono',busIds:[]});
      openOutputSettings(onBack,initialLayout,initialBuses);
    });
  },0);
}

const AudioRouting={openForClip,openForSource,openOutputSettings};
if(typeof window!=='undefined'){
  window.AudioRouting=AudioRouting;
  window.addEventListener('audio-routing:open',event=>{
    const detail=event?.detail||{};
    if(detail.clipId) openForClip(detail.clipId);
    else if(detail.audioSourceId||detail.sourceId) openForSource(detail.audioSourceId||detail.sourceId);
  });
}

export { AudioRouting };

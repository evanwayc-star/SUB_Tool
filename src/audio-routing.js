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
import { State, normalizeAudioProject } from './state.js';
import { Seq } from './sequence.js';
import { Media } from './media.js';
import { AudioPipeline } from './audio-routing-engine.js';
import { drawTimeline } from './timeline-renderer.js';
import { renderAudioTracks } from './mixer.js';
import { escapeHTML } from './util.js';
import { emit, on } from './events.js';
import { History } from './history.js';
import { openModal, closeModal, showToast } from './ui.js';
import { LAYOUTS, MAX_AUDIO_BUSES, DELIVERY_PRESETS, layoutWidth, AudioRoutingModel, resizeProjectAudioBuses } from './audio-routing-engine.js';


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
function displaySource(route){ return `Stream ${route.sourceStream+1} · Ch ${route.sourceChannel+1}`; }
function updateViews(){
  Media.applyGains();
  renderAudioTracks();
  drawTimeline();
}
let activeProjectEditor=null;
let activeRoutingModal=null;
on('audio:sourceRegistered',({project,sourceId,channels,options})=>{
  if(State.audioProject===project && activeProjectEditor?.isActive()){
    const modal=activeRoutingModal;
    activeProjectEditor.registerSource(sourceId,channels,options,project);
    if(activeRoutingModal===modal && modal?.session?.isCurrent()) modal.rerender?.();
  }
});
/* Routing 頁面的重畫與父子導航是同一次 editor handoff；其他 Modal 的 replacement
   才終止整段編輯。Modal lease 同時擋掉旧頁的延後綁定與 detached button。 */
function openRoutingModal(editor,title,html,buttons,opts={}){
  const {rerender,...modalOptions}=opts;
  activeRoutingModal?.session?.close?.({committed:true});
  const owner={editor,session:null,rerender};
  const owns=()=>activeRoutingModal===owner&&(owner.session?.isCurrent?.()??true);
  const dismiss=()=>{
    if(activeRoutingModal===owner) activeRoutingModal=null;
    editor.dismiss();
  };
  activeRoutingModal=owner;
  owner.session=openModal(title,html,buttons.map(button=>({...button,act:(...args)=>{
    if(owns()&&editor.isActive()) return button.act?.(...args);
  }})),{...modalOptions,onDismiss:dismiss,onReplaced:dismiss});
  return {isCurrent:owns};
}
function projectEditor({ output=false, label='設定輸出音訊聲道' }={}){
  activeProjectEditor?.dismiss();
  let owned=project();
  const owns=()=>State.audioProject===owned;
  let editor;
  const finish=History.beginAudioPreview(()=>editor.baseline(),owns,()=>{
    if(activeProjectEditor===editor) activeRoutingModal?.session?.close();
    editor.dismiss();
  });
  activeProjectEditor=editor=AudioRoutingModel.editProject(owned,{
    output,label,
    owns,
    preview:draft=>{ State.audioProject=draft; updateViews(); owned=State.audioProject; },
    record:message=>emit('history:record',message),
    finished:finish,
  });
  return activeProjectEditor;
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
function routeTableHtml(routes,buses){
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
function syncRouteDraftFromDialog(editor,sourceId){
  const changes=[];
  document.querySelectorAll('.audio-route-table tbody tr').forEach(row=>{
    const select=row.querySelector('.audio-route-target');
    if(!select||select.dataset.dirty!=='1') return;
    changes.push({sourceStream:Number(row.dataset.stream),sourceChannel:Number(row.dataset.channel),busId:select.value||''});
    select.dataset.dirty='0';
    row.querySelector('.audio-route-state').textContent=select.value?'已配線':'未配線';
  });
  if(changes.length) editor.setRoutes(sourceId,changes);
}
function openForRoutingSource(source, editor=null){
  if(!source){ showToast('找不到這個音訊來源'); return; }
  const sourceId=clipSourceId(source);
  if(!sourceId){ showToast('此來源沒有可配線的音訊識別'); return; }
  if(!editor){
    activeProjectEditor?.dismiss();
    routesForSource(source);
    editor=projectEditor({label:'設定音訊配線：'+(source.name||'音訊來源')});
  }
  if(!editor.isActive()) return;
  const p=editor.current();
  const routes=p.sourceMaps[sourceId]?.channels||[];
  const count=p.buses.length;
  const modalSession=openRoutingModal(editor,'音訊配線',
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
      <div class="audio-route-actions"><button id="audioRouteAuto" type="button">自動順序對應</button><button id="audioRouteClear" type="button">清除這個來源的配線</button><button id="audioRouteOutput" type="button">主專案音軌設定…</button></div>
      <div class="audio-route-help">例如：來源 Stream 1 · Ch 1–6 可分別指定到 A3–A8。不同影片各自保存自己的分配。</div>
      ${routeTableHtml(routes,p.buses)}
    </div>`,
    [{label:'儲存配線',primary:true,act:()=>{
      syncRouteDraftFromDialog(editor,sourceId);
      const result=editor.commit();
      if(!result.saved){ showToast(result.error); return; }
      closeModal({committed:true});
    }},{label:'取消',act:()=>closeModal()}],{width:'680px',rerender:()=>openForRoutingSource(source,editor)});
  setTimeout(()=>{
    if(!modalSession.isCurrent()||!editor.isActive()) return;
    const rerender=()=>openForRoutingSource(source,editor);
    const sync=()=>syncRouteDraftFromDialog(editor,sourceId);
    const countInput=document.getElementById('audioBusCount');
    document.getElementById('audioBusCountApply')?.addEventListener('click',()=>{ sync(); if(editor.setBusCount(countInput?.value)) rerender(); });
    document.querySelectorAll('.audio-count-preset').forEach(button=>button.addEventListener('click',()=>{ sync(); if(editor.setBusCount(button.dataset.count)) rerender(); }));
    document.querySelectorAll('.audio-route-target').forEach(select=>select.addEventListener('change',()=>{ select.dataset.dirty='1'; sync(); }));
    document.getElementById('audioRouteAuto')?.addEventListener('click',()=>{
      const available=editor.current().buses.filter(bus=>!bus.locked);
      document.querySelectorAll('.audio-route-target').forEach((select,index)=>{ select.value=available[index]?.id||''; select.dataset.dirty='1'; });
      sync();
    });
    document.getElementById('audioRouteClear')?.addEventListener('click',()=>{
      document.querySelectorAll('.audio-route-target').forEach(select=>{ select.value=''; select.dataset.dirty='1'; });
      sync();
    });
    document.getElementById('audioRouteOutput')?.addEventListener('click',()=>{ sync(); const child=editor.output(); if(child) openOutputSettingsEditor(child,rerender); });
  },0);
}
function openForClip(clipId){
  const clip=Seq.byId(clipId);
  if(!clip){ showToast('找不到這個影片片段'); return; }
  openForRoutingSource(clip);
}
function openForSource(sourceKey){
  const external=Media.getExternalAudioSource?.(sourceKey);
  if(external){ openForRoutingSource(external); return; }
  const clip=Seq.byId(sourceKey)||State.clips.find(item=>clipSourceId(item)===sourceKey);
  if(clip){ openForRoutingSource(clip); return; }
  showToast('找不到這個音訊來源');
}
function outputRowHtml(stream,index,buses=project().buses,delivery=false){
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
  const channelNames=layout==='stereo'?['左聲道 L','右聲道 R']:layout==='5.1'?['左 L','右 R','中央 C','低頻 LFE','左環繞 Ls','右環繞 Rs']:['單聲道'];
  const assignments=delivery?`<div class="audio-output-channels">${channelNames.map((name,channel)=>{
    const selected=String(stream.busIds?.[channel]||'');
    const options=['<option value="">— 未指定 —</option>',...buses.map((bus,busIndex)=>
      `<option value="${escapeHTML(bus.id)}" ${String(bus.id)===selected?'selected':''}>${escapeHTML(`A${busIndex+1} · ${busName(bus,busIndex)}`)}</option>`)].join('');
    return `<label><span>${name}</span><select class="audio-output-bus" data-channel="${channel}" aria-label="輸出 ${index+1} ${name}">${options}</select></label>`;
  }).join('')}</div>`:`<select class="audio-output-start">${busOpts}</select>`;
  const streamName=String(stream.name||'');
  return `<tr data-stream-id="${escapeHTML(stream.id)}"><td><div class="audio-output-stream"><span class="audio-output-index">${index+1}</span><input class="audio-output-name" aria-label="Stream ${index+1} 名稱" value="${escapeHTML(streamName)}" placeholder="Stream 名稱"></div></td><td><select class="audio-output-layout" aria-label="輸出 ${index+1} 聲道格式">${layoutOpts}</select></td><td>${assignments}</td><td><button type="button" class="audio-output-remove" title="移除此輸出 stream">−</button></td></tr>`;
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
    const selections=[...row.querySelectorAll('.audio-output-bus')];
    const firstIndex=selections.length?buses.findIndex(bus=>String(bus.id)===selections[0].value):-1;
    const busIds=selections.length?Array.from({length:width},(_,channel)=>
      selections[channel]?.value ?? (firstIndex>=0?buses[firstIndex+channel]?.id||'':''))
      :startIndex>=0?buses.slice(startIndex,startIndex+width).map(bus=>bus.id):[];
    const name=(row.querySelector('.audio-output-name')?.value||'').trim();
    streams.push({id,layout,busIds,...(name?{name}:{})});
  });
  return streams;
}
function openOutputSettingsEditor(editor,onBack=null,{deliveryFormat=null,delivery=false}={}){
  if(!editor.isActive()) return;
  const p=editor.current();
  const wavDelivery=deliveryFormat==='wav';
  const streams=p.exportLayout.streams;
  const rows=streams.map((stream,index)=>outputRowHtml(stream,index,p.buses,delivery)).join('')||'<tr><td colspan="4" class="audio-route-empty">尚無可輸出的專案音訊軌。</td></tr>';
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
    ? '從主專案選擇這份 WAV 要輸出的音軌，依群組及聲道順序寫入同一個多聲道 WAV；只影響這份輸出。'
    : delivery?'從主專案選擇這份檔案要輸出的音軌。Stereo 的左、右聲道可各自指定任意 A 軌；只影響這份輸出。'
      :'設定主專案的 A 軌數量與預設輸出編組。每份輸出檔案可以另行選擇要使用的音軌。';
  const modalSession=openRoutingModal(editor,delivery?(wavDelivery?'WAV 輸出音軌設定':'輸出檔案音軌設定'):'主專案音軌設定',
    `<div class="audio-output-dialog">
      <div class="audio-route-help">${outputHelp}</div>
      ${delivery?`<div class="audio-bus-count">主專案可用音軌：<strong>${p.buses.length}</strong></div>`:`<div class="audio-bus-count"><label>專案音訊軌數
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
      <div class="audio-delivery-presets"><span>${delivery?'輸出配置':'預設輸出配置'}</span><button id="audioOutputAllMono" type="button">全部專案音軌（Mono）</button>${presetButtons}</div>
      <div class="audio-output-table-wrap"><table class="audio-output-table"><thead><tr><th>${wavDelivery?'WAV 聲道群組':'輸出音軌'}</th><th>聲道格式</th><th>${delivery?'輸出聲道 ← 專案音軌':'專案音軌'}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="audio-output-actions"><button id="audioOutputAdd" type="button">＋ 新增 ${wavDelivery?'群組':'Stream'}</button></div>
    </div>`,
    [{label:'儲存輸出設定',primary:true,act:()=>{
      const current=editor.current();
      editor.setStreams(outputStreamsFromDialog(current.buses,current.exportLayout.streams));
      const result=editor.commit();
      if(!result.saved){ showToast(result.error); return; }
      closeModal({committed:true});
      if(onBack) onBack(result);
    }},{label:onBack?(delivery?'返回匯出清單':'返回配線'):'取消',act:()=>{
      if(onBack){ editor.cancel(); closeModal({committed:true}); onBack({saved:false}); }
      else closeModal();
    }}],{width:'860px',rerender:()=>openOutputSettingsEditor(editor,onBack,{deliveryFormat,delivery})});
  setTimeout(()=>{
    if(!modalSession.isCurrent()||!editor.isActive()) return;
    const rerender=()=>{
      // 版面重畫會重新建立聲道選單；先保存畫面上的暫存選擇，
      // 才不會在 Mono / Stereo / 5.1 切換時把使用者剛選的編組還原掉。
      const current=editor.current();
      editor.setStreams(outputStreamsFromDialog(current.buses,current.exportLayout.streams));
      openOutputSettingsEditor(editor,onBack,{deliveryFormat,delivery});
    };
    const countInput=document.getElementById('audioOutputBusCount');
    document.getElementById('audioOutputBusApply')?.addEventListener('click',()=>{
      const current=editor.current();
      editor.setStreams(outputStreamsFromDialog(current.buses,current.exportLayout.streams));
      if(editor.setBusCount(countInput?.value)) openOutputSettingsEditor(editor,onBack,{deliveryFormat,delivery});
    });
    document.querySelectorAll('.audio-output-count-preset').forEach(button=>button.addEventListener('click',()=>{
      if(countInput) countInput.value=button.dataset.count||'';
      const current=editor.current();
      editor.setStreams(outputStreamsFromDialog(current.buses,current.exportLayout.streams));
      if(editor.setBusCount(button.dataset.count)) openOutputSettingsEditor(editor,onBack,{deliveryFormat,delivery});
    }));
    document.getElementById('audioOutputAllMono')?.addEventListener('click',()=>{
      if(!editor.allMono()) return;
      openOutputSettingsEditor(editor,onBack,{deliveryFormat,delivery});
    });
    document.querySelectorAll('.audio-delivery-preset').forEach(button=>button.addEventListener('click',()=>{
      const preset=DELIVERY_PRESETS.find(item=>item.id===button.dataset.preset);
      if(!preset) return;
      const result=editor.preset(preset);
      if(result?.error){ showToast(result.error); return; }
      if(!result) return;
      openOutputSettingsEditor(editor,onBack,{deliveryFormat,delivery});
    }));
    document.querySelectorAll('.audio-output-layout,.audio-output-start,.audio-output-bus').forEach(select=>select.addEventListener('change',()=>{
      // 聲道格式改變時需要重建聲道欄位；只在 layout 欄變動才重畫。
      if(select.classList.contains('audio-output-layout')) rerender();
      else { const current=editor.current(); editor.setStreams(outputStreamsFromDialog(current.buses,current.exportLayout.streams)); }
    }));
    document.querySelectorAll('.audio-output-name').forEach(input=>input.addEventListener('input',()=>{
      const current=editor.current(); editor.setStreams(outputStreamsFromDialog(current.buses,current.exportLayout.streams));
    }));
    document.querySelectorAll('.audio-output-remove').forEach(button=>button.addEventListener('click',()=>{
      const row=button.closest('tr');
      const rows=[...document.querySelectorAll('.audio-output-table tbody tr[data-stream-id]')];
      if(rows.length<=1){ showToast('至少保留一個輸出 Stream。'); return; }
      row?.remove();
      const current=editor.current();
      editor.setStreams(outputStreamsFromDialog(current.buses,current.exportLayout.streams));
      document.querySelectorAll('.audio-output-table tbody tr[data-stream-id]').forEach((streamRow,index)=>{
        const numberCell=streamRow.querySelector('.audio-output-index');
        if(numberCell) numberCell.textContent=String(index+1);
        const nameInput=streamRow.querySelector('.audio-output-name');
        if(nameInput) nameInput.setAttribute('aria-label',`Stream ${index+1} 名稱`);
        streamRow.querySelector('.audio-output-layout')?.setAttribute('aria-label',`輸出 ${index+1} 聲道格式`);
        streamRow.querySelectorAll('.audio-output-bus').forEach(select=>{
          select.setAttribute('aria-label',`輸出 ${index+1} ${select.closest('label')?.querySelector('span')?.textContent||'聲道'}`);
        });
      });
    }));
    document.getElementById('audioOutputAdd')?.addEventListener('click',()=>{
      const current=editor.current();
      editor.setStreams(outputStreamsFromDialog(current.buses,current.exportLayout.streams));
      editor.addStream();
      openOutputSettingsEditor(editor,onBack,{deliveryFormat,delivery});
    });
  },0);
}

function openOutputSettings(){
  openOutputSettingsEditor(projectEditor({output:true}));
}
function openDeliveryOutputSettings(spec,onBack=null,{deliveryFormat=null}={}){
  activeProjectEditor?.dismiss();
  openOutputSettingsEditor(AudioRoutingModel.editDelivery(spec,{wav:deliveryFormat==='wav'}),onBack,{deliveryFormat,delivery:true});
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

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  document.body.innerHTML = '<div id="modalBg"><div class="modal"><div id="modalTitle"></div><div id="modalBody"></div><div id="modalFoot"></div></div></div><div id="historyList"></div>';
});
vi.mock('../src/media.js', () => ({ Media: { applyGains: vi.fn(), tracks: [] } }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));
import { State, ensureAudioSourceMap, resetAudioProject } from '../src/state.js';
import { AudioRouting } from '../src/audio-routing.js';
import { Media } from '../src/media.js';
import { History, recordHistory } from '../src/history.js';
import { on } from '../src/events.js';
import { closeModal } from '../src/ui.js';
import { buildProjectAudioPlan } from '../src/project-audio.js';
import { createDeliveryAudioSpec } from '../src/export-job-engine.js';

on('history:record', recordHistory);
const button = label => [...document.querySelectorAll('#modalFoot button')].find(el => el.textContent === label);
const click = selector => { document.querySelector(selector).click(); vi.runAllTimers(); };
const act = label => { button(label).click(); vi.runAllTimers(); };
const open = () => { AudioRouting.openOutputSettings(); vi.runAllTimers(); };
const source = () => { AudioRouting.openForClip('master-clip'); vi.runAllTimers(); };
const route = (channel, busId) => {
  const select = document.querySelector('.audio-route-table tr[data-channel="'+channel+'"] select');
  select.value = busId; select.dispatchEvent(new Event('change')); vi.runAllTimers();
};
const plan = () => buildProjectAudioPlan({audioProject:State.audioProject,clips:State.clips});

beforeEach(() => {
  vi.useFakeTimers();
  closeModal({committed:true});
  State.cues=[]; State.tracks=[{name:'字幕',visible:true,locked:false}]; State.notes=[];
  State.clips=[{id:'master-clip',audioSourceId:'master',audioSrc:'video',primary:true,path:'C:/master.mov',name:'八聲道',in:0,out:3,offset:0,dur:3}];
  State.externalAudioState=[]; State.videoTracks=[{name:'視訊軌 1',visible:true,locked:false}];
  resetAudioProject();
  ensureAudioSourceMap('master', Array.from({ length: 8 }, (_, sourceChannel) => ({ sourceStream: 0, sourceChannel })));
  ensureAudioSourceMap('second', [{ sourceStream: 1, sourceChannel: 0 }]);
  State.audioProject.sourceMaps.second.channels[0].busIds = [State.audioProject.buses[7].id];
  History.reset();
  vi.clearAllMocks();
});
afterEach(() => { closeModal(); vi.runAllTimers(); vi.useRealTimers(); });

it('多次 bus 預覽即時生效，取消恢復全來源配線且不留下 History', () => {
  const initial=structuredClone(State.audioProject), history=structuredClone(History.stack);
  open();
  click('.audio-output-count-preset[data-count="4"]');
  expect(State.audioProject.buses).toHaveLength(4);
  expect(Media.applyGains).toHaveBeenCalled();
  click('.audio-output-count-preset[data-count="6"]');
  expect(State.audioProject.buses).toHaveLength(6);
  expect(History.stack).toEqual(history);
  act('取消');
  expect(State.audioProject).toEqual(initial);
  expect(History.stack).toEqual(history);
  expect(plan().buses[7].inputs[0].sourceChannel).toBe(7);
});

it('多次 preview 只在保存建立一筆 History，Undo/Redo 恢復全部配線', () => {
  const initial=structuredClone(State.audioProject);
  open();
  click('.audio-delivery-preset[data-preset="6-fm"]');
  click('.audio-delivery-preset[data-preset="8-fm"]');
  expect(History.stack).toHaveLength(1);
  act('儲存輸出設定');
  const saved=structuredClone(State.audioProject);
  expect(saved.exportLayout.streams).toHaveLength(2);
  expect(History.stack).toHaveLength(2);
  expect(plan().buses[7].inputs[0].sourceChannel).toBe(7);
  History.undo(); expect(State.audioProject).toEqual(initial);
  History.redo(); expect(State.audioProject).toEqual(saved);
});

it('來源↔輸出往返共用一次編輯；子頁存檔仍可由父頁取消', () => {
  const initial=structuredClone(State.audioProject);
  source(); route(0,State.audioProject.buses[7].id);
  expect(plan().buses[7].inputs.map(input=>input.sourceChannel)).toEqual([0,7]);
  click('#audioRouteOutput'); click('.audio-output-count-preset[data-count="4"]');
  act('儲存輸出設定');
  expect(document.querySelector('.audio-route-dialog')).not.toBeNull();
  expect(State.audioProject.buses).toHaveLength(4);
  expect(History.stack).toHaveLength(1);
  act('取消');
  expect(State.audioProject).toEqual(initial);
  expect(History.stack).toHaveLength(1);
});

it('子頁返回只還原該頁，父頁保存來源配線與後續輸出變更共一筆 History', () => {
  const initial=structuredClone(State.audioProject);
  source(); route(0,State.audioProject.buses[7].id);
  const parent=structuredClone(State.audioProject);
  click('#audioRouteOutput'); click('.audio-output-count-preset[data-count="4"]');
  act('返回配線'); expect(State.audioProject).toEqual(parent);
  click('#audioRouteOutput'); click('.audio-delivery-preset[data-preset="8-fm"]');
  act('儲存輸出設定'); act('儲存配線');
  const saved=structuredClone(State.audioProject);
  expect(saved.sourceMaps.master.channels[0].busIds).toEqual([saved.buses[7].id]);
  expect(saved.exportLayout.streams).toHaveLength(2);
  expect(History.stack).toHaveLength(2);
  History.undo(); expect(State.audioProject).toEqual(initial);
  History.redo(); expect(State.audioProject).toEqual(saved);
});

it.each(['direct','backdrop'])('巢狀視窗 %s 關閉會取消整段編輯', how => {
  const initial=structuredClone(State.audioProject);
  source(); click('#audioRouteClear'); click('#audioRouteOutput');
  click('.audio-output-count-preset[data-count="4"]');
  if(how==='direct') closeModal(); // Escape 共用此正式入口。
  else document.getElementById('modalBg').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
  expect(State.audioProject).toEqual(initial);
  expect(History.stack).toHaveLength(1);
  expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
});

it('無效輸出不能提交，取消仍恢復預覽且不污染 History', () => {
  const initial=structuredClone(State.audioProject);
  open(); click('#audioOutputAdd'); act('儲存輸出設定');
  expect(document.getElementById('modalBg').classList.contains('show')).toBe(true);
  expect(History.stack).toHaveLength(1);
  act('取消'); expect(State.audioProject).toEqual(initial);
});

it('交付列編輯與 WAV 排序只回傳自己的結果，不改專案或 History', () => {
  const initial=structuredClone(State.audioProject), spec=createDeliveryAudioSpec(initial,{}), back=vi.fn();
  AudioRouting.openDeliveryOutputSettings(spec,back,{deliveryFormat:'wav'}); vi.runAllTimers();
  const selects=document.querySelectorAll('.audio-output-start');
  const left=selects[0].value; selects[0].value=selects[1].value; selects[1].value=left;
  act('儲存輸出設定');
  expect(back).toHaveBeenCalledWith(expect.objectContaining({saved:true,spec:expect.objectContaining({wavBusIds:[initial.buses[1].id,initial.buses[0].id,...initial.buses.slice(2).map(bus=>bus.id)]})}));
  expect(State.audioProject).toEqual(initial);
  expect(spec).toEqual(createDeliveryAudioSpec(initial,{}));
  expect(History.stack).toHaveLength(1);
  expect(Media.applyGains).not.toHaveBeenCalled();
});

it('取消交付列更動也不影響來源專案', () => {
  const initial=structuredClone(State.audioProject), spec=createDeliveryAudioSpec(initial,{}), back=vi.fn();
  AudioRouting.openDeliveryOutputSettings(spec,back); vi.runAllTimers();
  click('.audio-delivery-preset[data-preset="2-fm"]'); act('返回配線');
  expect(back).toHaveBeenCalledWith({saved:false});
  expect(State.audioProject).toEqual(initial);
  expect(History.stack).toHaveLength(1);
});

it('已替換專案後舊視窗取消不能覆寫新專案', () => {
  open(); click('.audio-output-count-preset[data-count="4"]');
  resetAudioProject(); const replacement=structuredClone(State.audioProject);
  closeModal(); expect(State.audioProject).toEqual(replacement);
});

it('輸出編輯直接重入來源配線時先撤回舊草稿，不把預覽當成新起點', () => {
  const initial=structuredClone(State.audioProject);
  open(); click('.audio-output-count-preset[data-count="4"]');
  source();
  expect(State.audioProject).toEqual(initial);
  route(0,State.audioProject.buses[7].id);
  act('取消');
  expect(State.audioProject).toEqual(initial);
  expect(History.stack).toHaveLength(1);
  expect(History.snap().audioProject).toEqual(initial);
});

it('背景工作在預覽期間記錄 History 時只收已提交配線，保存後 Undo 保留背景工作', () => {
  const initial=structuredClone(State.audioProject);
  source(); click('#audioRouteClear'); click('#audioRouteOutput');
  click('.audio-delivery-preset[data-preset="8-fm"]');
  State.clips[0].audioLimiterSpec={max:-6,min:-12,inputBoost:0};
  State.clips[0].hasAudioLimiter=true;
  recordHistory('背景音訊效果完成');
  expect(History.stack).toHaveLength(2);
  expect(History.stack[1].snap.audioProject).toEqual(initial);
  act('儲存輸出設定'); act('儲存配線');
  const saved=structuredClone(State.audioProject);
  expect(History.stack).toHaveLength(3);
  History.undo();
  expect(State.audioProject).toEqual(initial);
  expect(State.clips[0].audioLimiterSpec.max).toBe(-6);
  History.redo();
  expect(State.audioProject).toEqual(saved);
  expect(State.clips[0].audioLimiterSpec.max).toBe(-6);
});

it('取消只撤回配線預覽，保留期間背景工作以及既有 Undo/Redo 步驟', () => {
  const initial=structuredClone(State.audioProject);
  source(); click('#audioRouteClear');
  State.clips[0].audioLimiterSpec={max:-6,min:-12,inputBoost:0};
  State.clips[0].hasAudioLimiter=true;
  recordHistory('背景音訊效果完成');
  const background=structuredClone(History.stack);
  act('取消');
  expect(State.audioProject).toEqual(initial);
  expect(History.stack).toEqual(background);
  expect(State.clips[0].audioLimiterSpec.max).toBe(-6);
  History.undo();
  const future=structuredClone(History.stack);
  open(); click('.audio-output-count-preset[data-count="4"]'); act('取消');
  expect(History.stack).toEqual(future);
  History.redo();
  expect(State.audioProject).toEqual(initial);
  expect(State.clips[0].audioLimiterSpec.max).toBe(-6);
});

it('History 投影的舊解除函式不清除較新 owner，restore/reset 會釋放投影', () => {
  const initial=structuredClone(State.audioProject);
  const oldRelease=History.beginAudioPreview(initial);
  const next=structuredClone(initial); next.buses[0].volume=0.5;
  History.beginAudioPreview(next);
  oldRelease();
  expect(History.snap().audioProject.buses[0].volume).toBe(0.5);
  History.restore(0);
  expect(History.snap().audioProject).toEqual(initial);
  History.beginAudioPreview(next);
  History.reset();
  expect(History.snap().audioProject).toEqual(initial);
});

// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State, History, Menus, UI, Media, ProjectModule;
const click = label => [...document.querySelectorAll('#modalFoot button')].find(button => button.textContent === label).click();
const clip = (id, values = {}) => ({ id, name: id, path: 'C:/' + id + '.mp4', in: 0, out: 10, dur: 10, offset: 0, vtrack: 0, ...values });
const dialogs = [
  { kind: 'duration', field: 'cdVal', apply: '套用', open: cue => Menus.showClipDuration(cue) },
  { kind: 'fade-in', field: 'cfInV', range: 'cfIn', apply: '套用', open: cue => Menus.showClipFade(cue) },
  { kind: 'fade-out', field: 'cfOutV', range: 'cfOut', apply: '套用', open: cue => Menus.showClipFade(cue) },
  { kind: 'crossfade', field: 'xfTV', range: 'xfT', apply: '建立溶接', open: cue => Menus.showCrossfade(cue) },
];
const namedInput=(label,type)=>{
  const matches=[...document.querySelectorAll('#modalBody input')].filter(input=>input.type===type&&input.getAttribute('aria-label')===label);
  expect(matches,`具名 ${type} 控制：${label}`).toHaveLength(1);return matches[0];
};

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html').body.innerHTML;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => target[key] || (() => {}) }));
  ({ State } = await import('../src/state.js')); ({ History } = await import('../src/history.js'));
  Menus = await import('../src/menus.js'); UI = await import('../src/ui.js');
  ({ Media } = await import('../src/media.js')); ProjectModule = await import('../src/project.js');
  vi.spyOn(Media, 'seek').mockResolvedValue(true);
  vi.spyOn(Media, 'restoreSequenceEditState').mockResolvedValue(true);
});

beforeEach(async () => {
  UI.closeModal();
  Object.assign(State, { tracks: [{ name: '字幕', visible: true }], cues: [], notes: [], clips: [], externalAudioState: [],
    videoTracks: [{ name: 'V1', visible: true }, { name: 'V2', visible: true }], duration: 20, fps: 25, dropFrame: false });
  History.reset();
  const saving = ProjectModule.ensureProjectSaved();
  if (document.getElementById('modalTitle').textContent === '開始前先儲存專案' && document.getElementById('modalBg').classList.contains('show')) click('稍後再說');
  await saving;
});
afterAll(() => { UI.closeModal(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); delete HTMLElement.prototype.scrollIntoView; });

it('大小與位置的具名百分比控制正確連動，套用與 Undo 保留原始單位',async()=>{
 const target=clip('geometry',{scale:1,posX:.5,posY:.5});State.clips=[target];History.reset();
 Menus.showImageGeom(target);await vi.advanceTimersByTimeAsync(0);
 for(const [label,value] of [['大小（%）',125],['水平位置（%）',30],['垂直位置（%）',70]]){
   const range=namedInput(label,'range'),number=namedInput(label,'number');
   range.value=String(value);range.dispatchEvent(new Event('input',{bubbles:true}));expect(+number.value).toBe(value);
   number.value=String(value+1);number.dispatchEvent(new Event('input',{bubbles:true}));expect(+range.value).toBe(value+1);
 }
 click('套用');expect(target).toMatchObject({scale:1.26,posX:.31,posY:.71});expect(History.stack).toHaveLength(2);
 History.undo();expect(State.clips[0]).toMatchObject({scale:1,posX:.5,posY:.5});
});

it.each(dialogs.map((dialog,index)=>({...dialog,label:['片段持續時間','淡入時間','淡出時間','影音溶接時間'][index]})))('$kind 的具名時間控制區分秒與時碼，調整後可提交與復原',async dialog=>{
 const {target}=await open(dialog),original=structuredClone(State.clips);
 const input=namedInput(dialog.label+'（時:分:秒:格）','text');
 if(dialog.range){
   const range=namedInput(dialog.label+'（秒）','range');range.value='2';range.dispatchEvent(new Event('input',{bubbles:true}));
   expect(input.value).toBe('00:00:02:00');
 }else input.value='00:00:02:00';
 click(dialog.apply);
 if(dialog.kind==='duration')expect(target.out-target.in).toBe(2);
 else if(dialog.kind==='fade-in')expect(target.fadeIn).toBe(2);
 else if(dialog.kind==='fade-out')expect(target.fadeOut).toBe(2);
 else expect(target).toMatchObject({fadeIn:2,offset:8});
 expect(History.stack).toHaveLength(2);History.undo();expect(State.clips).toMatchObject(original);
});

async function open(dialog) {
  const target = clip('target', { offset: 10, fadeIn: .4, fadeOut: .8 });
  State.clips = [clip('previous'), target]; History.reset();
  dialog.open(target); await vi.advanceTimersByTimeAsync(0);
  return { target, input: document.getElementById(dialog.field) };
}

it.each(dialogs.flatMap(dialog => ['direct', 'change'].flatMap(mode =>
  ['1:2:3:4:5', '1.5junk', '00::01:00', 'Infinity', '1e2', '0x10', ''].map(raw => ({ ...dialog, mode, raw }))
)))('$kind $mode 非法輸入「$raw」保留對話框與草稿，不改片段、slider或History', async dialog => {
  const { input } = await open(dialog), original = structuredClone(State.clips);
  const range = dialog.range && document.getElementById(dialog.range), rangeValue = range?.value;
  input.value = dialog.raw;
  if (dialog.mode === 'change') input.dispatchEvent(new Event('change', { bubbles: true }));
  expect(input.value).toBe(dialog.raw); if (range) expect(range.value).toBe(rangeValue);
  click(dialog.apply);
  expect(State.clips).toEqual(original); expect(History.stack).toHaveLength(1);
  expect(document.getElementById('modalBg').classList.contains('show')).toBe(true);
  expect(input.isConnected).toBe(true); expect(input.value).toBe(dialog.raw);
});

it.each(dialogs.flatMap(dialog => [
  { raw: '00:00:02:00', seconds: 2 }, { raw: '0120', seconds: 1.8 }, { raw: '1.5', seconds: 1.5 },
].map(value => ({ ...dialog, ...value }))))('$kind 有效輸入 $raw 依既有時碼／十進秒數語意提交一次並可 Undo／Redo', async dialog => {
  const { target, input } = await open(dialog), original = structuredClone(State.clips);
  input.value = dialog.raw; input.dispatchEvent(new Event('change', { bubbles: true }));
  click(dialog.apply);
  // change 正規化的顯示時碼與片段時長，都沿用目前專案的影格格網。
  const seconds = Math.round(dialog.seconds * 25) / 25;
  if (dialog.kind === 'duration') expect(target.out - target.in).toBeCloseTo(seconds, 8);
  else if (dialog.kind === 'fade-in') expect(target.fadeIn).toBeCloseTo(seconds, 8);
  else if (dialog.kind === 'fade-out') expect(target.fadeOut).toBeCloseTo(seconds, 8);
  else { expect(target.offset).toBeCloseTo(10 - seconds, 8); expect(target.fadeIn).toBeCloseTo(seconds, 8); }
  expect(History.stack).toHaveLength(2); expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
  const committed = structuredClone(State.clips);
  History.undo(); expect(State.clips).toMatchObject(original);
  History.redo(); expect(State.clips).toMatchObject(committed);
});

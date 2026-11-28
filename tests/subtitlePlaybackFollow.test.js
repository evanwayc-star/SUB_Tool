// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State, Media, time = 2;
const frames = new Map();
let nextFrame = 1;

function presentFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(performance.now());
}

beforeAll(async () => {
  vi.useFakeTimers();
  const parsed = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  // Browser drawing/frame scheduling and the transport clock are adapters;
  // app bootstrap, ticker, index, selection and row rendering stay real.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', callback => { const id = nextFrame++; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue();
  HTMLMediaElement.prototype.load = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLCanvasElement.prototype.getContext = () => new Proxy({
    measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => (target[key] = value, true) });
  ({ State } = await import('../src/state.js'));
  ({ Media } = await import('../src/media.js'));
  vi.spyOn(Media, 'displayTime').mockImplementation(() => time);
  vi.spyOn(Media, 'seqTick').mockImplementation(() => {});
  vi.spyOn(Media, 'syncAudioDrift').mockImplementation(() => {});
  await import('../src/app.js');
  await vi.waitFor(() => expect(document.getElementById('stMsg').textContent).toContain('就緒'));
});

afterAll(() => {
  Media.playing = false;
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it('真 app ticker 跟隨目前列表軌，間隙清除藍條，換軌撤銷另一軌的偏好', () => {
  Object.assign(State, {
    cues: [
      { id: 'first-track', start: 0, end: 10, text: '第一軌', track: 0 },
      { id: 'current-track', start: 0, end: 4, text: '目前列表', track: 1 },
    ],
    tracks: [{ name: 'S1', visible: true }, { name: 'S2', visible: true }], trackCount: 2,
    listTrack: 1, duration: 10, autoSelect: true, fps: 25, activeId: null,
  });
  window.SUB.renderListTrackSel(); window.SUB.renderAll();
  Media.playing = true;
  presentFrame();
  expect(State.activeId).toBe('current-track'); expect(State.selectedId).toBe('current-track');
  expect(document.querySelector('#sublist .sub-row.active')?.dataset.id).toBe('current-track');

  time = 5; presentFrame();
  expect(State.activeId).toBe(null); expect(document.querySelector('#sublist .sub-row.active')).toBe(null);

  State.listTrack = 0; window.SUB.renderListTrackSel(); window.SUB.renderAll(); presentFrame();
  expect(State.activeId).toBe('first-track'); expect(State.selectedId).toBe('first-track');
  State.listTrack = 1; time = 2; window.SUB.renderListTrackSel(); window.SUB.renderAll(); presentFrame();
  expect(State.activeId).toBe('current-track'); expect(State.selectedId).toBe('current-track');
});

it.each([23.976,24,25,29.97,30])('播放器、列高亮與時碼在 %s FPS 的同一格換句', async fps => {
  const {getExactFps,secToEncore} = await import('../src/time.js');
  const rate=getExactFps(fps), head=395*Math.round(rate)+15;
  const cue=(id,start,end)=>({id,text:id,track:0,start:start/rate,end:end/rate});
  Object.assign(State,{fps,dropFrame:false,duration:410,listTrack:0,autoSelect:false,activeId:null,
    cues:[cue('previous',head-2,head),cue('single',head,head+1)],
    trackCount:1,tracks:[{name:'OCR',visible:true}]});
  window.SUB.renderAll();
  Media.playing=true;
  for(const [offset,id] of [[-1,'previous'],[-0.2,'single'],[0,'single'],[0.8,null],[0,'single']]){
    time=(head+offset)/rate;
    presentFrame();
    expect(document.querySelector('#tcCur').textContent).toBe(secToEncore(time,fps,false));
    expect(document.querySelector('#videoSub [data-cue]')?.dataset.cue??null).toBe(id);
    expect(document.querySelector('#sublist .sub-row.active')?.dataset.id??null).toBe(id);
  }
  Media.playing=false;
});

it('原生視窗在影片間隙隱藏後，字幕在黑畫面的首格仍可見', () => {
  Media.playing=false;
  const mode=vi.spyOn(Media,'mpvMode','get').mockReturnValue(true);
  const gap=vi.spyOn(Media,'inGap').mockReturnValue(true);
  try {
    Object.assign(State,{fps:25,duration:10,listTrack:0,cues:[{id:'gap',text:'黑畫面字幕',track:0,start:2,end:3}],
      trackCount:1,tracks:[{name:'OCR',visible:true}]});
    time=2; window.SUB.renderVideoSub();
    const layer=document.querySelector('#videoSub');
    expect(layer.querySelector('[data-cue="gap"]')?.textContent).toContain('黑畫面字幕');
    expect(layer.classList.contains('mpv-hit-layer')).toBe(false);
    time=3; window.SUB.renderVideoSub();
    expect(layer.querySelector('[data-cue]')).toBeNull();
  } finally { mode.mockRestore(); gap.mockRestore(); }
});

it('暫停中重新判定專案格率，字幕同步採用新的終點格', async () => {
  Media.playing=false;
  time=1.019;
  Object.assign(State,{fps:24,duration:4,listTrack:0,cues:[{id:'grid',text:'單格',track:0,start:1,end:1+1/24}],
    trackCount:1,tracks:[{name:'OCR',visible:true}]});
  window.SUB.renderAll();
  expect(document.querySelector('#videoSub [data-cue]')?.dataset.cue).toBe('grid');
  window.SUB.setFps(30);
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#tcCur').textContent).toBe('00:00:01:01');
  expect(document.querySelector('#videoSub [data-cue]')).toBeNull();
});

it.each([true, false])('空白 S2 的實際新增按鈕保留目的軌與 Undo（S1 locked=%s）', firstLocked => {
  Media.playing = false;
  Object.assign(State, {
    cues: [], tracks: [{ name: 'S1', visible: true, locked: firstLocked }, { name: 'S2', visible: true, locked: false }],
    trackCount: 2, listTrack: 1, duration: 10, fps: 25, activeId: null,
  });
  window.SUB.selectCueSingle(null);
  window.SUB.History.reset(); window.SUB.renderListTrackSel(); window.SUB.renderAll();
  document.querySelector('[data-act="add-cue-below"]').click();
  expect(State.cues).toHaveLength(1);
  expect(State.cues[0].track).toBe(1);
  expect(State.selectedId).toBe(State.cues[0].id);
  expect(document.querySelector('#sublist .sub-row')?.dataset.id).toBe(State.cues[0].id);
  window.SUB.History.undo(); expect(State.cues).toEqual([]);
  window.SUB.History.redo(); expect(State.cues).toHaveLength(1); expect(State.cues[0].track).toBe(1);

  State.cues = []; window.SUB.selectCueSingle(null);
  document.querySelector('[data-act="add-cue-above"]').click();
  expect(State.cues).toHaveLength(1); expect(State.cues[0].track).toBe(1);
  State.cues = []; State.tracks[1].locked = true; window.SUB.selectCueSingle(null);
  document.querySelector('[data-act="add-cue-below"]').click();
  expect(State.cues).toEqual([]);
});

function openCueMenu() {
  Media.playing = false; time = 1;
  Object.assign(State, {
    cues: [{ id: 'menu-a', start: 0, end: 4, text: '右鍵目標', track: 0 },
      { id: 'menu-b', start: 4, end: 8, text: '下一句', track: 0 }],
    tracks: [{ name: 'S1', visible: true, locked: false }],
    trackCount: 1, listTrack: 0, duration: 10, autoSelect: true, activeId: null,
  });
  window.SUB.History.reset(); window.SUB.renderListTrackSel(); window.SUB.renderAll();
  window.SUB.selectCueSingle('menu-a', false);
  document.querySelector('#sublist .sub-row[data-id="menu-a"]')
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
  expect(document.getElementById('ctxmenu').classList.contains('show')).toBe(true);
}

function clickCueMenu(label) {
  const item = [...document.querySelectorAll('#ctxmenu .ci')].find(button => button.textContent.includes(label));
  expect(item).toBeTruthy(); item.click();
}

it.each(['播放跨句', '鍵盤換句', '背景辨識', '同 ID 替換字幕', '替換軌道', '鎖定軌道', '切換工作區']) (
  '既有字幕右鍵選單在%s後拒絕舊命令，不能刪錯對象', async change => {
    openCueMenu();
    if (change === '播放跨句') { Media.playing = true; time = 5; presentFrame(); }
    else if (change === '鍵盤換句') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true }));
      expect(State.selectedId).toBe('menu-b');
    } else if (change === '背景辨識') {
      const { insertAsrSubtitles } = await import('../src/speech-recognition.js');
      insertAsrSubtitles([{ clip: { in: 0, out: 8, offset: 0 }, segments: [{ start: 1, end: 2, text: '背景結果' }] }]);
      expect(State.selectedId).not.toBe('menu-a');
    } else if (change === '同 ID 替換字幕') State.cues[0] = { ...State.cues[0] };
    else if (change === '替換軌道') State.tracks[0] = { ...State.tracks[0] };
    else if (change === '鎖定軌道') State.tracks[0].locked = true;
    else {
      const { resetProject } = await import('../src/project.js');
      const cues = State.cues, tracks = State.tracks;
      resetProject();
      // Even restoring the same objects/IDs cannot revive a previous workspace's command.
      State.cues = cues; State.tracks = tracks; State.trackCount = 1; State.listTrack = 0;
      window.SUB.selectCueSingle('menu-a', false);
    }
    const before = structuredClone(State.cues), selected = State.selectedId, history = window.SUB.History.stack.length;
    clickCueMenu('刪除字幕');
    expect(State.cues).toEqual(before); expect(State.selectedId).toBe(selected);
    expect(window.SUB.History.stack).toHaveLength(history);
    expect(document.getElementById('toast').textContent).toContain('重新開啟右鍵選單');
    Media.playing = false;
  },
);

it('仍持有選取的真字幕右鍵選單正常刪除目標，一次 Undo/Redo', () => {
  openCueMenu();
  const before = structuredClone(State.cues);
  clickCueMenu('刪除字幕');
  expect(State.cues).toEqual(before);
  expect(document.getElementById('modalBody').textContent).toContain('1');
  document.querySelector('#modalFoot button.primary').click();
  expect(State.cues.map(cue => cue.id)).toEqual(['menu-b']);
  expect(window.SUB.History.stack).toHaveLength(2);
  window.SUB.History.undo(); expect(State.cues).toEqual(before);
  window.SUB.History.redo(); expect(State.cues.map(cue => cue.id)).toEqual(['menu-b']);
});

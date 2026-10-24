// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State, History, Project, Media, UI, validateProjectIntegrity, migrateProjectSchema, isProjectDirty;
let desktop, resetMedia;
const baseDocument = () => ({
  app: 'SUB Tool', version: 3, fps: 25, tracks: [], cues: [], clips: [], media: {}, notes: [],
});
const fileFor = data => new File([JSON.stringify(data)], 'tracks.subtool', { type: 'application/json' });
const desktopInput = data => ({ path: 'C:/projects/tracks.subtool', b64: Buffer.from(JSON.stringify(data)).toString('base64') });

beforeAll(async () => {
  const parsed = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  HTMLCanvasElement.prototype.getContext = () => {
    const target = { measureText() { return { width: this.font?.includes('"') ? 2 : 1 }; },
      createLinearGradient: () => ({ addColorStop() {} }) };
    return new Proxy(target, { get: (object, key) => object[key] || (() => {}),
      set: (object, key, value) => (object[key] = value, true) });
  };
  desktop = { isDesktop: true, fontsList: vi.fn().mockResolvedValue({ fonts: [] }),
    stat: vi.fn().mockResolvedValue({ exists: false }) };
  Object.defineProperty(window, 'subtool', { configurable: true, value: desktop });
  ({ State } = await import('../src/state.js'));
  ({ History } = await import('../src/history.js'));
  ({ Project, validateProjectIntegrity, migrateProjectSchema, isProjectDirty } = await import('../src/project.js'));
  ({ Media } = await import('../src/media.js'));
  UI = await import('../src/ui.js');
  resetMedia = vi.spyOn(Media, 'reset'); // The real Media implementation still runs.
});

beforeEach(() => {
  UI.closeModal();
  Project.apply({ ...baseDocument(), tracks: [{ name: '保留軌', visible: true, locked: false }],
    cues: [{ track: 1, start: 0, end: 1, text: '目前專案' }],
    media: { name: 'current.mov', path: 'C:/media/current.mov' }, playhead: 7 });
  State.presetEdit = { original: '保留草稿' };
  History.reset();
  resetMedia.mockClear();
  desktop.stat.mockClear();
  desktop.fontsList.mockClear();
});

afterAll(() => { UI.closeModal(); resetMedia.mockRestore(); vi.clearAllTimers(); });

const invalidExpansions = [
  { trackCount: 0xffffffff },
  { videoTrackCount: String(0xffffffff) },
  { version: 1, cues: [{ track: 0xfffffffe, text: '舊零基字幕' }] },
  { version: 2, cues: [{ track: String(0xffffffff), text: '一基字幕' }] },
  { clips: [{ type: 'image', vtrack: 0xfffffffe, path: 'C:/media/still.png', dur: 1, in: 0, out: 1 }] },
];

it.each(['apply', 'load', 'loadDesktop', 'open'])('public %s 拒絕巨大隱含建軌，保留 State、History、還原 owner 與字型視窗', async entry => {
  for (const patch of invalidExpansions) {
    const data = { ...baseDocument(), ...patch }, original = JSON.stringify(data);
    const owns = Project.captureWorkspaceOwnership(), pending = Project.pendingMediaRelink();
    const snapshot = () => JSON.stringify({ committed: History.snap(), history: History.stack, hi: History.hi,
      presetEdit: State.presetEdit, mediaName: State.mediaName, mediaPath: State.mediaPath });
    const before = snapshot(), dirty = isProjectDirty();
    const modal = UI.openModal('目前視窗', '<p>仍有效</p>', []);
    // A broken implementation must fail safely in the test, never allocate billions of rows.
    const push = Array.prototype.push; let attemptedAllocations = 0;
    Array.prototype.push = function (...items) {
      if (this === State.tracks || this === State.videoTracks) {
        attemptedAllocations += items.length;
        if (this.length >= 3) throw new Error('controlled allocation gate: unvalidated dense expansion');
      }
      return push.apply(this, items);
    };
    try {
      const result = entry === 'apply' ? Project.apply(data) : entry === 'load' ? await Project.load(fileFor(data)) :
        entry === 'loadDesktop' ? await Project.loadDesktop(desktopInput(data)) :
          await Project.open(async () => desktopInput(data), { confirm: false });
      expect(result).toBe(false);
    } finally { Array.prototype.push = push; }
    expect(attemptedAllocations).toBe(0);
    expect(snapshot()).toBe(before);
    expect(Project.pendingMediaRelink()).toEqual(pending);
    expect(pending.plan.peekPlayhead()).toBe(7);
    expect(owns()).toBe(true);
    expect(isProjectDirty()).toBe(dirty);
    expect(modal.isCurrent()).toBe(true);
    expect(document.getElementById('modalTitle').textContent).toBe('目前視窗');
    expect(resetMedia).not.toHaveBeenCalled();
    expect(desktop.stat).not.toHaveBeenCalled();
    expect(desktop.fontsList).not.toHaveBeenCalled();
    expect(JSON.stringify(data)).toBe(original);
    expect(document.getElementById('toast').textContent).toMatch(/補建.*空軌/);
  }
});

it.each([1, 2, 3])('schema %s 保留合法 sparse 字串索引與部分宣告的兩類軌道', async version => {
  const data = { ...baseDocument(), version, trackCount: '5', videoTrackCount: '4', media: { name: 'sparse.mov' },
    tracks: [{ name: '第一軌', color: '#33aa66' }, { name: '第二軌', locked: true }],
    videoTracks: [{ name: '底圖', visible: false }],
    cues: [{ track: version === 1 ? '6' : '7', text: '稀疏字幕', start: 0, end: 1 }],
    clips: [{ type: 'image', path: 'C:/media/still.png', vtrack: '5', in: 0, out: 1, dur: 1 }] };
  expect(Project.apply(data)).toBe(true);
  expect(State.tracks).toHaveLength(7);
  expect(State.trackCount).toBe(7);
  expect(State.cues[0].track).toBe(6);
  expect(State.tracks[0]).toMatchObject({ name: '第一軌', color: '#33aa66' });
  expect(State.tracks[1].locked).toBe(true);
  expect(State.videoTracks).toHaveLength(6);
  expect(State.videoTracks[0]).toMatchObject({ name: '底圖', visible: false });
  expect(Project.pendingMediaRelink().plan.pendingClips()[0].vtrack).toBe(5);
  expect(data.cues[0].track).toBe(version === 1 ? '6' : '7');
  expect(data.clips[0].vtrack).toBe('5');
});

it('允許超過補建預算的明確軌道，載入與 Undo 基準保留全部 records', async () => {
  const tracks = Array.from({ length: 2048 }, (_, i) => ({ name: '字幕 ' + i, locked: i % 2 === 1 }));
  const videoTracks = Array.from({ length: 1536 }, (_, i) => ({ name: '畫面 ' + i, opacity: i % 100 }));
  // An old counter can understate complete arrays; records must still win.
  const data = { ...baseDocument(), tracks, videoTracks, trackCount: '2', videoTrackCount: '1',
    cues: [{ track: '2048', text: '最後宣告軌', start: 0, end: 1 }] };
  await Project.load(fileFor(data));
  expect(State.tracks).toHaveLength(2048);
  expect(State.videoTracks).toHaveLength(1536);
  expect(State.tracks[2047]).toMatchObject(tracks[2047]);
  expect(State.videoTracks[1535]).toMatchObject(videoTracks[1535]);
  expect(History.stack).toHaveLength(1);
  expect(History.stack[0].snap.tracks).toHaveLength(2048);
  expect(History.stack[0].snap.videoTracks).toHaveLength(1536);
  expect(isProjectDirty()).toBe(false);
  State.cues[0].text = '編輯後'; History.record('編輯'); History.undo();
  expect(State.cues[0].text).toBe('最後宣告軌');
  expect(State.tracks).toHaveLength(2048);
  expect(State.videoTracks).toHaveLength(1536);
});

it('補建額度按兩類缺少 records 的總數計算，精確拒絕額外一軌，重複正規化不改額度', async () => {
  // Migration supplies the first subtitle record. The first video record is implicit.
  const boundary = { ...baseDocument(), trackCount: 513, videoTrackCount: 512 };
  expect(validateProjectIntegrity(migrateProjectSchema(boundary)).valid).toBe(true);
  const rejected = validateProjectIntegrity(migrateProjectSchema({ ...boundary, videoTrackCount: 513 }));
  expect(rejected.valid).toBe(false);
  expect(rejected.errors.join(' ')).toMatch(/補建.*1025.*1024/);
  await Project.load(fileFor(boundary));
  expect(State.tracks).toHaveLength(513);
  expect(State.videoTracks).toHaveLength(512);
  expect(History.stack[0].snap.tracks).toHaveLength(513);
  expect(History.stack[0].snap.videoTracks).toHaveLength(512);
  expect(isProjectDirty()).toBe(false);
});

it.each([1, 2, 3])('schema %s 舊負數索引與軌數保持原有最小軌數及字幕基準相容性', version => {
  const data = { ...baseDocument(), version, trackCount: '-1', videoTrackCount: '-1', media: { name: 'legacy.mov' },
    cues: [{ track: '-1', text: '歷史字幕' }], clips: [{ vtrack: '-1', path: 'C:/media/legacy.mov' }] };
  expect(Project.apply(data)).toBe(true);
  expect(State.tracks).toHaveLength(1);
  expect(State.videoTracks).toHaveLength(1);
  expect(State.cues[0].track).toBe(version === 1 ? -1 : 0);
  expect(Project.pendingMediaRelink().plan.pendingClips()[0].vtrack).toBe(-1);
});

it.each([1,2,3])('schema %s 載入格網上的數字字串後，相對新增、History 與 dirty 共用數值時間',async version=>{
  const data={...baseDocument(),version,duration:2,tracks:[{name:'字幕'}],
    cues:[{track:version===1?0:1,start:'1',end:'2',text:'原字幕'}]};
  await Project.load(fileFor(data));
  const {setSelection}=await import('../src/state.js');
  const {addCueRelative}=await import('../src/subtitle-model.js');
  expect(State.cues[0]).toMatchObject({start:1,end:2});
  expect(History.stack[0].snap.cues[0]).toMatchObject({start:1,end:2});
  expect(isProjectDirty()).toBe(false);
  setSelection({kind:'sub',ids:[State.cues[0].id]});
  expect(addCueRelative(1)).toMatchObject({start:2,end:4});
  expect(History.stack).toHaveLength(2);
  expect(History.stack[1].snap.cues[1]).toMatchObject({start:2,end:4});
  expect(isProjectDirty()).toBe(true);
  History.undo();
  expect(State.cues).toHaveLength(1);
  expect(State.cues[0]).toMatchObject({start:1,end:2});
  expect(isProjectDirty()).toBe(false);
  History.redo();
  expect(State.cues).toHaveLength(2);
  expect(State.cues[1]).toMatchObject({start:2,end:4});
  expect(isProjectDirty()).toBe(true);
  expect(data.cues[0]).toMatchObject({start:'1',end:'2'});
});

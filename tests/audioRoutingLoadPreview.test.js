// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const media = vi.hoisted(() => ({
  displayTime: vi.fn(() => 0), applyGains: vi.fn(), tracks: [],
  externalAudio: { list: vi.fn(() => []), get: vi.fn(() => null) }, externalAudioSources: [],
  loadDesktopMedia: vi.fn(), reset: vi.fn(), seek: vi.fn(),
  waitForPendingProjectRestore: vi.fn().mockResolvedValue(),
  restorePendingImageClips: vi.fn().mockResolvedValue({ restored: 0, pending: 0 }),
}));
vi.mock('../src/media.js', () => ({ Media: media }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn() }));
vi.mock('../src/mixer.js', () => ({ renderAudioTracks: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn() }));

let State, History, Project, resetProject, AudioRouting, closeModal, desk;
beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="modalBg"><div class="modal"><div id="modalTitle"></div><div id="modalBody"></div><div id="modalFoot"></div></div></div><div id="historyList"></div>';
  desk = { isDesktop: true, stat: vi.fn(async () => ({ exists: true })), saveProject: vi.fn(async () => 'C:/saved.subtool') };
  Object.defineProperty(window, 'subtool', { configurable: true, value: desk });
  ({ State } = await import('../src/state.js'));
  ({ History } = await import('../src/history.js'));
  ({ Project, resetProject } = await import('../src/project.js'));
  ({ AudioRouting } = await import('../src/audio-routing.js'));
  ({ closeModal } = await import('../src/ui.js'));
  State.clips = []; State.cues = []; State.notes = [];
  History.stack = []; History.hi = -1;
  media.loadDesktopMedia.mockReset();
  media.applyGains.mockClear();
});
afterEach(() => { closeModal?.(); resetProject?.(); delete window.subtool; vi.restoreAllMocks(); });

it.each(['output','source-child'])('首次公開專案媒體復原完成時撤回 %s 路由預覽，History 與儲存不收草稿', async page => {
  let finishMedia;
  const pendingMedia=new Promise(resolve => { finishMedia = resolve; });
  const {Seq}=await import('../src/sequence.js');
  media.loadDesktopMedia.mockImplementation((_path,plan)=>{
    // Native intake publishes restored placements before its pending image/freeze work completes.
    Seq.restore(plan.pendingClips());return pendingMedia;
  });
  const data = {
    app: 'SUB Tool', version: 3, duration: 20, fps: 25,
    media: { name: 'Original.mov', size: 100, path: 'C:/media/Original.mov' },
    tracks: [], cues: [{ start: 1, end: 2, text: '原字幕', track: 1 }], notes: [],
    clips: [{ id: 'original', name: 'Original.mov', audioSourceId: 'mother', audioSrc: 'video', path: 'C:/media/Original.mov', dur: 20, in: 0, out: 20, offset: 0, vtrack: 0, primary: true }],
    audioProject: { buses: [{ id: 'L', name: '左', volume: 1 }, { id: 'R', name: '右', volume: 1 }], sourceMaps: { mother: { channels: [{ sourceStream: 0, sourceChannel: 0, busIds: ['L'], enabled: true }] } } },
  };
  const b64 = Buffer.concat([Buffer.from([0xff,0xfe]), Buffer.from(JSON.stringify(data),'utf16le')]).toString('base64');
  const loading = Project.loadDesktop({ path: 'C:/Original.subtool', b64 });
  await vi.waitFor(() => expect(media.loadDesktopMedia).toHaveBeenCalledOnce());
  const initial = structuredClone(State.audioProject);
  const gains=[];media.applyGains.mockImplementation(()=>gains.push(structuredClone(State.audioProject)));
  if (page === 'source-child') {
    AudioRouting.openForClip('original');
    await new Promise(resolve => setTimeout(resolve, 0));
    document.querySelector('#audioRouteOutput').click();
  } else AudioRouting.openOutputSettings();
  await new Promise(resolve => setTimeout(resolve, 0));
  document.querySelector('.audio-output-count-preset[data-count="4"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(State.audioProject.buses).toHaveLength(4);
  expect(History.committedSnapshot().audioProject).toEqual(initial);
  const staleSave = [...document.querySelectorAll('#modalFoot button')].find(button => button.textContent === '儲存輸出設定');
  finishMedia(); await loading;
  expect(State.audioProject).toEqual(initial);
  expect(History.stack[0].snap.audioProject).toEqual(initial);
  expect(gains.at(-1)).toEqual(initial);
  expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
  await Project.saveAs();
  const saved = JSON.parse(Buffer.from(desk.saveProject.mock.calls[0][1],'base64').subarray(2).toString('utf16le'));
  expect(saved.audioProject).toEqual(initial);
  staleSave.click();
  expect(History.stack).toHaveLength(1);
  expect(State.audioProject).toEqual(initial);
});

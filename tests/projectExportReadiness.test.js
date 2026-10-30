// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), updatePlayhead: vi.fn(), layoutTimeline: vi.fn() }));
vi.mock('../src/notes.js', () => ({ renderNotes: vi.fn(), getNotesGeneralFileData: vi.fn(), getNotesEdiusFileData: vi.fn() }));

let Project, Media, State, History, showExportVideoDialog, closeModal, desk;
const b64 = data => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(data), 'utf16le')]).toString('base64');
const image = (name, offset, vtrack = 0) => ({
  id: name, name, path: `C:/source/${name}.png`, type: 'image',
  dur: 36000, in: 0, out: 5, offset, vtrack, natW: 1920, natH: 1080,
});
const projectData = () => ({
  app: 'SUB Tool', version: 3, fps: 25, duration: 10, media: {}, tracks: [], cues: [], notes: [],
  videoTracks: [{ name: 'V1', visible: true }], clips: [image('ready', 0), image('missing', 5)],
});

beforeAll(async () => {
  document.body.innerHTML = readFileSync('index.html', 'utf8');
  const video = document.getElementById('video');
  video.pause = vi.fn(); video.play = vi.fn(async () => {}); video.load = vi.fn();
  desk = {
    isDesktop: true, stat: vi.fn(), fileURL: vi.fn(async path => `file:///${path}`),
    saveProject: vi.fn(async () => 'C:/saved.subtool'), exportVideo: vi.fn(async () => 'job-1'),
    listDir: vi.fn(async () => []), getStartupFile: vi.fn(async () => null),
  };
  Object.defineProperty(window, 'subtool', { configurable: true, value: desk });
  ({ State } = await import('../src/state.js'));
  ({ Media } = await import('../src/media.js'));
  ({ Project } = await import('../src/project.js'));
  ({ History } = await import('../src/history.js'));
  ({ showExportVideoDialog } = await import('../src/subio.js'));
  ({ closeModal } = await import('../src/ui.js'));
});
beforeEach(() => {
  document.getElementById('modalBody').innerHTML = '';
  desk.stat.mockImplementation(async path => ({ exists: !path.includes('missing') }));
  desk.exportVideo.mockClear(); desk.saveProject.mockClear();
});
afterEach(() => { closeModal(); Media.reset(); });

it('真實專案載入保留缺圖時，交付不能把兩張圖片靜默截成已復原的一張', async () => {
  await Project.loadDesktop({ b64: b64(projectData()) });
  expect(State.clips.map(clip => clip.name)).toEqual(['ready.png']);
  await Project.saveAs();
  const saved = JSON.parse(Buffer.from(desk.saveProject.mock.calls[0][1], 'base64').subarray(2).toString('utf16le'));
  expect(saved.clips).toHaveLength(2);

  await showExportVideoDialog();
  expect(document.getElementById('evRowsContainer')).toBeNull();
  expect(document.getElementById('toast').textContent).toMatch(/missing/);
  expect(desk.exportVideo).not.toHaveBeenCalled();
});

async function submitDelivery() {
  await vi.waitFor(() => expect(document.querySelector('.ev-outdir')).not.toBeNull());
  const directory = document.querySelector('.ev-outdir');
  directory.value = 'C:/delivery'; directory.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('evSubmitBtn').click();
}

it.each(['range', 'hidden'])('未復原圖片不影響所選交付（%s）時，可送出正確內容與時長', async mode => {
  const data = projectData();
  if (mode === 'range') data.exportOut = 5;
  else { data.clips[1].vtrack = 1; data.videoTracks.push({ name: '隱藏', visible: false, locked: true, scale: .5, opacity: .4, posX: .3, posY: .7 }); }
  await Project.loadDesktop({ b64: b64(data) });
  if (mode === 'hidden') expect(State.videoTracks[1]).toMatchObject(data.videoTracks[1]);
  if (mode === 'hidden') {
    await Project.saveAs();
    const saved = JSON.parse(Buffer.from(desk.saveProject.mock.calls[0][1], 'base64').subarray(2).toString('utf16le'));
    expect(saved.videoTracks[1]).toMatchObject(data.videoTracks[1]);
  }
  await showExportVideoDialog(); await submitDelivery();
  await vi.waitFor(() => expect(desk.exportVideo).toHaveBeenCalledOnce());
  const [job] = desk.exportVideo.mock.calls[0];
  expect(job.clips.map(clip => clip.path)).toEqual(['C:/source/ready.png']);
  expect(job.duration).toBe(mode === 'range' ? 5 : 10);
});

it('交付清單已開啟後擴大範圍，送出重驗未復原片段且不消耗項目', async () => {
  await Project.loadDesktop({ b64: b64({ ...projectData(), exportOut: 5 }) });
  await showExportVideoDialog();
  await vi.waitFor(() => expect(document.querySelector('.ev-outdir')).not.toBeNull());
  State.exportOut = 10;
  await submitDelivery();
  await vi.waitFor(() => expect(document.getElementById('toast').textContent).toMatch(/missing/));
  expect(desk.exportVideo).not.toHaveBeenCalled();
  expect(document.querySelectorAll('.delivery-card')).toHaveLength(1);
  State.exportOut = 5;
  document.getElementById('evSubmitBtn').click();
  await vi.waitFor(() => expect(desk.exportVideo).toHaveBeenCalledOnce());
  expect(desk.exportVideo.mock.calls[0][0].duration).toBe(5);
});

it('來源恢復後重新載入及交付會包含原先未復原的尾段', async () => {
  const data = projectData();
  await Project.loadDesktop({ b64: b64(data) });
  await showExportVideoDialog();
  expect(document.getElementById('evRowsContainer')).toBeNull();
  desk.stat.mockResolvedValue({ exists: true });
  await Project.loadDesktop({ b64: b64(data) });
  expect(State.clips).toHaveLength(2);
  expect(Project.unrestoredClips()).toEqual([]);
  await showExportVideoDialog(); await submitDelivery();
  await vi.waitFor(() => expect(desk.exportVideo).toHaveBeenCalledOnce());
  const [job] = desk.exportVideo.mock.calls[0];
  expect(job.duration).toBe(10);
  expect(job.clips.map(clip => clip.path)).toEqual(['C:/source/ready.png', 'C:/source/missing.png']);
});

it.each([false, true])('隱藏未復原影片的聲音依既有 bus 靜音規則決定是否阻擋（muted=%s）', async muted => {
  const data = projectData();
  data.clips[1] = { ...data.clips[1], type: 'video', path: 'C:/source/missing.mov', audioSourceId: 'missing-audio', vtrack: 1 };
  data.videoTracks.push({ name: '隱藏影片', visible: false });
  data.audioProject = {
    buses: [{ id: 'a1', name: 'A1', muted, volume: 1 }],
    sourceMaps: { 'missing-audio': { channels: [{ sourceStream: 0, sourceChannel: 0, busIds: ['a1'], enabled: true, gain: 1 }] } },
    exportLayout: { streams: [{ id: 'out', layout: 'mono', busIds: ['a1'] }] },
  };
  await Project.loadDesktop({ b64: b64(data) });
  expect(State.clips).toHaveLength(1);
  await showExportVideoDialog();
  if (!muted) {
    expect(document.getElementById('evRowsContainer')).toBeNull();
    expect(document.getElementById('toast').textContent).toMatch(/missing/);
    expect(desk.exportVideo).not.toHaveBeenCalled();
  } else {
    await submitDelivery();
    await vi.waitFor(() => expect(desk.exportVideo).toHaveBeenCalledOnce());
    expect(desk.exportVideo.mock.calls[0][0].audioPlan.buses.every(bus => !bus.inputs.length)).toBe(true);
  }
});

it('尚無 runtime 圖片時仍說明缺檔，而非將專案當成無素材', async () => {
  const data = projectData(); data.clips = [data.clips[1]];
  await Project.loadDesktop({ b64: b64(data) });
  expect(State.clips).toEqual([]);
  await showExportVideoDialog();
  expect(document.getElementById('toast').textContent).toMatch(/未完成復原.*missing/);
  expect(document.getElementById('evRowsContainer')).toBeNull();
});

it('無主影片載入仍先清除舊 runtime，純音訊文件的時長／音訊與軌設定可再次保存', async () => {
  await Media.addImageDesktop('C:/source/old.png', image('old', 0));
  Media.createExternalAudioSource({ audioSourceId: 'old-audio', name: '舊聲音', path: 'C:/old.wav', duration: 8, in: 0, out: 8 });
  const data = { ...projectData(), duration: 20, clips: [],
    videoTracks: [{ name: '既有隱藏軌', visible: false, locked: true, scale: .6, opacity: .3 }],
    externalAudioSources: [{ audioSourceId: 'offline-audio', name: '未連線聲音', path: 'C:/missing.wav', duration: 12, in: 2, out: 12, offset: 10 }],
  };
  await Project.loadDesktop({ b64: b64(data) });
  expect(State.clips).toEqual([]);
  expect(Media.externalAudioSources).toEqual([]);
  expect(State.duration).toBe(20);
  expect(State.videoTracks[0]).toMatchObject(data.videoTracks[0]);
  await Project.saveAs();
  const saved = JSON.parse(Buffer.from(desk.saveProject.mock.calls[0][1], 'base64').subarray(2).toString('utf16le'));
  expect(saved.clips).toEqual([]);
  expect(saved.duration).toBe(20);
  expect(saved.externalAudioSources).toHaveLength(1);
  expect(saved.externalAudioSources[0]).toMatchObject(data.externalAudioSources[0]);
  expect(saved.videoTracks[0]).toMatchObject(data.videoTracks[0]);
});

it('讀取未復原 metadata 不能修改待復原專案，已交接圖片刪除不會復活', async () => {
  await Project.loadDesktop({ b64: b64({ ...projectData(), exportIn: 5, exportOut: 10 }) });
  const pending = Project.unrestoredClips();
  expect(pending.map(clip => clip.name)).toEqual(['missing']);
  pending[0].path = 'C:/different.png'; pending[0].offset = 500;
  Media.removeClip(State.clips[0].id);
  History.record('移除已復原圖片');
  expect(Project.unrestoredClips().map(clip => clip.name)).toEqual(['missing']);
  await Project.saveAs();
  const saved = JSON.parse(Buffer.from(desk.saveProject.mock.calls[0][1], 'base64').subarray(2).toString('utf16le'));
  expect(saved.clips).toHaveLength(1);
  expect(saved.clips[0]).toMatchObject({ path: 'C:/source/missing.png', offset: 5 });
  await showExportVideoDialog();
  expect(document.getElementById('toast').textContent).toMatch(/missing/);
  expect(document.getElementById('evRowsContainer')).toBeNull();
  History.undo();
  expect(State.clips.map(clip => clip.name)).toEqual(['ready.png']);
  expect(Project.unrestoredClips().map(clip => clip.name)).toEqual(['missing']);
  State.exportIn = 0; State.exportOut = 5;
  await showExportVideoDialog(); await submitDelivery();
  await vi.waitFor(() => expect(desk.exportVideo).toHaveBeenCalledOnce());
  expect(desk.exportVideo.mock.calls[0][0].clips.map(clip => clip.path)).toEqual(['C:/source/ready.png']);
});

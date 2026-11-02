// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const encode = data => Buffer.concat([
  Buffer.from([255, 254]), Buffer.from(JSON.stringify(data), 'utf16le'),
]).toString('base64');

afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  delete window.subtool;
  delete HTMLElement.prototype.scrollIntoView;
});

it('開啟專案後只播放、縮放與收到來源長度時，關閉不應要求儲存', async () => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear();
  document.body.innerHTML = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html').body.innerHTML;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: () => ({ width: 1 }), createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => (target[key] = value, true) }));
  let closeListener;
  const api = { isDesktop: true, configLoad: async () => ({}), configSave: async () => true,
    fontsList: async () => ({ fonts: [] }), recentProjects: async () => [], status: async () => ({ ffmpeg: true }),
    getStartupFile: async () => null, onProgress: vi.fn(), onQueueStatus: vi.fn(), onOpenFile: vi.fn(),
    onAppRequestClose: callback => { closeListener = callback; }, closeApp: vi.fn(), stat: async () => ({ exists: true }) };
  window.subtool = api;
  const { State } = await import('../src/state.js');
  const { Project, isProjectDirty } = await import('../src/project.js');
  const { Media } = await import('../src/media.js');
  const { Seq } = await import('../src/sequence.js');
  const Timeline = await import('../src/timeline-renderer.js');
  vi.spyOn(Project, '_isFontAvailable').mockReturnValue(true);
  vi.spyOn(Media, 'loadDesktopMedia').mockImplementation(async (_, plan) => {
    const saved = plan.pendingClips()[0];
    const clip = Seq.add({ ...saved, web: { url: 'file:///source.mov' } });
    plan.materializeClip(saved, clip);
    Media.activeClipId = clip.id;
  });
  vi.spyOn(Media, 'waitForPendingProjectRestore').mockResolvedValue();
  await import('../src/app.js');
  await vi.waitFor(() => expect(closeListener).toBeTypeOf('function'));
  const data = { app: 'SUB Tool', version: 3, fps: 25, duration: 10,
    media: { name: 'source.mov', path: 'C:/source.mov', size: 100 },
    tracks: [{ name: '字幕', visible: true }], videoTracks: [{ name: 'V1', visible: true }], cues: [], notes: [],
    clips: [{ name: 'source.mov', path: 'C:/source.mov', dur: 10, in: 0, out: 10, offset: 0, vtrack: 0, primary: true }] };
  await Project.loadDesktop({ path: 'C:/project.subtool', b64: encode(data) });
  expect(State.clips).toHaveLength(1);
  expect(isProjectDirty()).toBe(false);
  document.getElementById('video').dispatchEvent(new Event('play'));
  Timeline.setZoom(120, 2);
  expect(isProjectDirty()).toBe(false);
  const {getPlayerAdapter}=await import('../src/media-player-adapter.js');
  const adapter=getPlayerAdapter();
  adapter.setMpvBridge({launch:async()=>({ok:true,sourceSessionId:'test-source'})});
  await adapter.enterMpv({src:'C:/source.mov'});
  Media._mpvPath='C:/source.mov';
  Media.observeMpvEvent({ event: 'property-change', name: 'duration', data: 10.04, sourceSessionId:'test-source' });
  expect(Seq.sourceDuration(State.clips[0])).toBe(10.04);
  expect(isProjectDirty()).toBe(false);
  closeListener();
  expect(api.closeApp).toHaveBeenCalledOnce();
  expect(document.getElementById('modalBody').textContent).not.toContain('關閉前是否要儲存');
  const { addCue } = await import('../src/subtitle-model.js');
  addCue(1, 2, '真正修改的字幕', 0);
  expect(isProjectDirty()).toBe(true);
  closeListener();
  expect(api.closeApp).toHaveBeenCalledOnce();
  expect(document.getElementById('modalBody').textContent).toContain('關閉前是否要儲存');
  Media.resetPresentationSession('test-finished');
  Media.playing = false;
});

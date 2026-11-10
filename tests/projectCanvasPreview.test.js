// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({
  State:{projectCanvas:null},
  runtime:{pause:vi.fn(),setProjectCanvas:vi.fn()},
  media:{mpvMode:true,playing:false,pause:vi.fn(),displayTime:vi.fn(),capturePlaybackTargetOwnership:vi.fn(),captureMediaOwnership:vi.fn(),seek:vi.fn()},
}));
vi.mock('../src/state.js',()=>({State:mock.State}));
vi.mock('../src/media.js',()=>({Media:mock.media}));
vi.mock('../src/media-player-adapter.js',()=>({getNativePreviewRuntime:()=>mock.runtime}));
vi.mock('../src/ui.js',()=>({setStatus:vi.fn()}));
let preview;
beforeEach(async()=>{
  vi.resetModules();vi.clearAllMocks();mock.State.projectCanvas=null;
  mock.media.mpvMode=true;mock.media.playing=false;mock.media.displayTime.mockReturnValue(7.25);
  mock.media.capturePlaybackTargetOwnership.mockReturnValue(()=>true);
  mock.media.captureMediaOwnership.mockReturnValue(()=>true);
  mock.runtime.pause.mockResolvedValue(true);mock.runtime.setProjectCanvas.mockResolvedValue({ok:true});
  mock.media.seek.mockResolvedValue({status:'presented'});
  preview=await import('../src/project-canvas-preview.js');
});
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:value=>resolve(value)};};

it('pauses through the existing owner, waits for native receipt, and re-presents timeline time once',async()=>{
  const ack=deferred();mock.runtime.setProjectCanvas.mockReturnValueOnce(ack.promise);
  const done=preview.prepareProjectCanvasPreview({width:1080,height:1920});
  expect(mock.media.pause).toHaveBeenCalledWith({seekOnPause:false});
  await Promise.resolve();expect(mock.media.seek).not.toHaveBeenCalled();
  ack.resolve({ok:true});await expect(done).resolves.toBe(true);
  expect(mock.media.seek).toHaveBeenCalledExactlyOnceWith(7.25);
  await preview.prepareProjectCanvasPreview({width:1080,height:1920});
  expect(mock.media.pause).toHaveBeenCalledTimes(1);
});

it('does not seek back over a newer user target or resume intent after native preparation',async()=>{
  const ack=deferred();let current=true;
  mock.media.capturePlaybackTargetOwnership.mockReturnValue(()=>current);
  mock.runtime.setProjectCanvas.mockReturnValueOnce(ack.promise);
  const done=preview.prepareProjectCanvasPreview({width:1080,height:1920});
  await Promise.resolve();current=false;mock.media.playing=true;
  ack.resolve({ok:true});await expect(done).resolves.toBe(true);
  expect(mock.media.seek).not.toHaveBeenCalled();
});

it('a cancelled draft never re-presents after committed Auto has superseded it',async()=>{
  const ack=deferred();mock.runtime.setProjectCanvas.mockReturnValueOnce(ack.promise);
  const done=preview.prepareProjectCanvasPreview({width:1080,height:1920});
  await Promise.resolve();preview.cancelProjectCanvasPreview();
  await Promise.resolve();ack.resolve({ok:true});
  await expect(done).resolves.toBe(false);
  expect(mock.runtime.setProjectCanvas).toHaveBeenLastCalledWith(null);
  await vi.waitFor(()=>expect(mock.media.seek).toHaveBeenCalledTimes(1));
});

it.each([undefined,null,false,{ok:false}])('requires an explicit native receipt for %j',async reply=>{
  mock.runtime.setProjectCanvas.mockResolvedValue(reply);
  await expect(preview.prepareProjectCanvasPreview({width:1080,height:1920})).rejects.toThrow('未確認');
  expect(mock.media.seek).not.toHaveBeenCalled();
});

it('treats release of the previous native session during project restore as cancellation rather than a new-project error',async()=>{
  let reject,current=true;
  mock.media.captureMediaOwnership.mockReturnValue(()=>current);
  mock.runtime.setProjectCanvas.mockImplementationOnce(()=>new Promise((resolve,fail)=>{reject=fail;}));
  const done=preview.prepareProjectCanvasPreview({width:320,height:320});
  await Promise.resolve();current=false;reject(new Error('previous source released'));
  await expect(done).resolves.toBe(false);expect(mock.media.seek).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock=vi.hoisted(()=>(
  {
    getExternalAudioSources:vi.fn(()=>[]),
    reset:vi.fn(),
    // _buildProjectData 會讀 displayTime() 存進 playhead（v5.2.0 起）。
    // mock 少了它會讓所有存檔測試以 TypeError 失敗——不是產品缺陷，是 mock 沒跟上。
    displayTime:vi.fn(()=>0),
    seek:vi.fn(),
    restorePendingImageClips:vi.fn().mockResolvedValue({restored:1,pending:0})
  }
));

vi.mock('../src/media.js',()=>({Media:mediaMock}));
vi.mock('../src/timeline.js',()=>({drawTimeline:vi.fn()}));
vi.mock('../src/history.js',()=>({History:{reset:vi.fn()}}));
vi.mock('../src/notes.js',()=>({renderNotes:vi.fn()}));
vi.mock('../src/ui.js',()=>({
  openModal:vi.fn(),closeModal:vi.fn(),showToast:vi.fn(),setStatus:vi.fn()
}));

let State;
let Project;
let resetProject;
let isProjectDirty;
let saveProject;

describe('project image persistence',()=>{
  beforeEach(async()=>{
    vi.resetModules();
    saveProject=vi.fn().mockResolvedValue('C:/projects/image-test.subtool');
    mediaMock.getExternalAudioSources.mockReturnValue([]);
    mediaMock.reset.mockClear();
    mediaMock.restorePendingImageClips.mockClear();
    mediaMock.restorePendingImageClips.mockResolvedValue({restored:1,pending:0});
    Object.defineProperty(window,'subtool',{
      configurable:true,
      value:{isDesktop:true,saveProject}
    });
    ({State}=await import('../src/state.js'));
    ({Project,resetProject,isProjectDirty}=await import('../src/project.js'));

    State.mediaName='program.mov';
    State.mediaPath='C:/source/program.mov';
    State.videoTracks=[
      {name:'視訊軌 1',visible:true,locked:false},
      {name:'圖片',visible:true,locked:false}
    ];
    State.clips=[{
      id:'image-a',type:'image',name:'Card',path:'C:/source/card.png',dur:36000,
      in:0,out:9,offset:4,vtrack:1,fps:25,scale:0.4,posX:0.2,posY:0.8
    }];
  });

  afterEach(()=>{
    resetProject?.();
    delete window.subtool;
  });

  it('saves and reloads image type, scale, and position through the public project path',async()=>{
    await expect(Project.saveAs()).resolves.toBe('C:/projects/image-test.subtool');

    const bytes=Buffer.from(saveProject.mock.calls[0][1],'base64');
    const data=JSON.parse(bytes.subarray(2).toString('utf16le'));
    expect(data.clips).toEqual([expect.objectContaining({
      type:'image',path:'C:/source/card.png',scale:0.4,posX:0.2,posY:0.8
    })]);

    State.clips=[]; // 真實載入流程會先由 Media.reset() 清掉舊 runtime clip。
    Project.apply(data);
    expect(State).not.toHaveProperty('_pendingClips');
    await Project.saveAs();
    const reloaded=JSON.parse(Buffer.from(saveProject.mock.calls.at(-1)[1],'base64').subarray(2).toString('utf16le'));
    expect(reloaded.clips).toEqual([expect.objectContaining({
      type:'image',path:'C:/source/card.png',scale:0.4,posX:0.2,posY:0.8
    })]);
  });

  it('saves the current playhead without leaking a pending field into State',async()=>{
    // playhead 是 v5.2.0 加的：存檔寫入 Media.displayTime()、載入時 seek 回去。
    // 這個欄位加進來時沒有補測試，導致 mock 缺 displayTime 讓整個檔案掛掉都沒被發現。
    mediaMock.displayTime.mockReturnValue(3610.5);
    await Project.saveAs();

    const bytes=Buffer.from(saveProject.mock.calls[0][1],'base64');
    const data=JSON.parse(bytes.subarray(2).toString('utf16le'));
    expect(data.playhead).toBe(3610.5);

    Project.apply(data);
    expect(State).not.toHaveProperty('_pendingPlayhead');
  });

  it('treats image geometry as unsaved project work',async()=>{
    await Project.saveAs();
    expect(isProjectDirty()).toBe(false);

    State.clips[0].scale=0.65;
    expect(isProjectDirty()).toBe(true);
  });

  it('asks Media to restore pending images when a desktop project has no primary video',async()=>{
    await Project.saveAs();
    const bytes=Buffer.from(saveProject.mock.calls[0][1],'base64');
    const data=JSON.parse(bytes.subarray(2).toString('utf16le'));
    data.media={name:null,size:0,path:null};

    const b64=Buffer.concat([Buffer.from([0xFF,0xFE]),Buffer.from(JSON.stringify(data),'utf16le')]).toString('base64');
    await Project.loadDesktop({b64,path:'C:/projects/image-only.subtool'});

    expect(mediaMock.restorePendingImageClips).toHaveBeenCalledTimes(1);
    const [plan]=mediaMock.restorePendingImageClips.mock.calls[0];
    expect(plan.pendingClips()).toEqual([expect.objectContaining({type:'image',path:'C:/source/card.png'})]);
    expect(State).not.toHaveProperty('_pendingClips');
  });
});

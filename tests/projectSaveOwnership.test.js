// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime=vi.hoisted(()=>({sources:[],time:0}));
vi.mock('../src/media.js',()=>({Media:{
  displayTime:()=>runtime.time,externalAudio:{list:()=>runtime.sources},reset:vi.fn(),seek:vi.fn(),
}}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn()}));
vi.mock('../src/notes.js',()=>({renderNotes:vi.fn()}));
vi.mock('../src/ui.js',()=>({setStatus:vi.fn(),showToast:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));

let State,History,Project,resetProject,isProjectDirty,getProjectDir,styles,desk;
const decode=b64=>JSON.parse(Buffer.from(b64,'base64').subarray(2).toString('utf16le'));
beforeEach(async()=>{
  vi.resetModules();
  document.body.innerHTML='<div id="historyList"></div>';
  desk={isDesktop:true,saveProject:vi.fn(async()=> 'C:/project.subtool'),writeProject:vi.fn(async file=>file),configSave:vi.fn()};
  Object.defineProperty(window,'subtool',{configurable:true,value:desk});
  ({State}=await import('../src/state.js'));
  ({History}=await import('../src/history.js'));
  ({Project,resetProject,isProjectDirty,getProjectDir}=await import('../src/project.js'));
  styles=await import('../src/substyle.js');
  Object.assign(State,{mediaName:null,mediaPath:null,mediaSize:0,duration:10,
    tracks:[{name:'字幕',fontSize:80,visible:true,locked:false}],trackCount:1,
    cues:[{id:'cue',text:'已提交',start:1,end:2,track:0}],notes:[],
    clips:[{id:'clip',name:'movie',path:'C:/movie.mp4',dur:10,in:0,out:10,offset:0,vtrack:0}],
    videoTracks:[{name:'影片',visible:true}],externalAudioState:[],externalAudioEnd:0,
    audioProject:{mode:'manual',buses:[{id:'bus',name:'聲道',muted:false,solo:false,gain:1}],sourceMaps:{},exportLayout:{streams:[{id:'stream',layout:'mono',busIds:['bus']}]}},
    fps:24,dropFrame:false,exportIn:null,exportOut:null,vtracksCollapsed:false});
  runtime.sources=[];runtime.time=0;
  styles.savePresets([]);
  History.reset();
});
afterEach(()=>{resetProject();vi.useRealTimers();delete window.subtool;});

const deferred=()=>{
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
};
const savedText=call=>decode(call[1]).cues[0]?.text;

describe('字幕與視訊軌高度的持久快照',()=>{
  it('存檔與開啟對稱保存高度，後續resize會變dirty',async()=>{
    State.tracks[0].height=90;State.videoTracks[0].height=100;History.reset();await Project.saveAs();
    const saved=decode(desk.saveProject.mock.calls[0][1]);
    expect(saved.tracks[0].height).toBe(90);expect(saved.videoTracks[0].height).toBe(100);
    State.tracks[0].height=190;State.videoTracks[0].height=200;History.record('height resize');
    expect(isProjectDirty()).toBe(true);
    Project.apply(saved);expect(State.tracks[0].height).toBe(90);expect(State.videoTracks[0].height).toBe(100);
  });
  it('高度預覽仍由History排除，缺值與錯誤資料使用正常預設',async()=>{
    State.tracks[0].height=90;State.videoTracks[0].height=100;History.reset();await Project.saveAs();
    const finish=History.beginPreview([{target:State.tracks[0],fields:['height']},{target:State.videoTracks[0],fields:['height']}]);
    State.tracks[0].height=190;State.videoTracks[0].height=200;expect(isProjectDirty()).toBe(false);await Project.save();
    const saved=decode(desk.writeProject.mock.calls[0][1]);expect(saved.tracks[0].height).toBe(90);expect(saved.videoTracks[0].height).toBe(100);finish();
    for(const height of [undefined,NaN,Infinity,'big']){
      Project.apply({...saved,tracks:[{name:'sub',height}],videoTracks:[{name:'video',height}]});
      expect(State.tracks[0].height).toBeUndefined();expect(State.videoTracks[0].height).toBeUndefined();
    }
    Project.apply({...saved,tracks:[{height:1}],videoTracks:[{height:1}]});expect(State.tracks[0].height).toBe(20);expect(State.videoTracks[0].height).toBe(24);
  });
});

describe('project save ownership',()=>{
  beforeEach(()=>{
    State.cues=[{id:'a',start:0,end:1,text:'original',track:0}];
    State.clips=[];State.duration=0;History.reset();
  });

  it('keeps edits made during disk IO dirty against the exact saved bytes',async()=>{
    const io=deferred();desk.saveProject.mockReturnValue(io.promise);
    const saving=Project.saveAs();
    await vi.waitFor(()=>expect(desk.saveProject).toHaveBeenCalledOnce());
    State.cues[0].text='new edit';io.resolve('C:/project.subtool');await saving;
    expect(savedText(desk.saveProject.mock.calls[0])).toBe('original');
    expect(isProjectDirty()).toBe(true);
    await Project.save();
    expect(savedText(desk.writeProject.mock.calls[0])).toBe('new edit');
    expect(isProjectDirty()).toBe(false);
  });

  it('does not attach an old save result to a new project',async()=>{
    const io=deferred();desk.saveProject.mockReturnValue(io.promise);
    const saving=Project.saveAs();
    await vi.waitFor(()=>expect(desk.saveProject).toHaveBeenCalledOnce());
    resetProject();State.cues[0].text='another project';io.resolve('C:/projects/old.subtool');
    await expect(saving).resolves.toBeNull();
    expect(getProjectDir()).toBeNull();expect(isProjectDirty()).toBe(true);
  });

  it('serializes saves and captures each requested snapshot before waiting',async()=>{
    await Project.saveAs();const io=deferred();desk.writeProject.mockReturnValueOnce(io.promise);
    State.cues[0].text='first';const first=Project.save();
    State.cues[0].text='second';const second=Project.save();
    await vi.waitFor(()=>expect(desk.writeProject).toHaveBeenCalledOnce());
    expect(savedText(desk.writeProject.mock.calls[0])).toBe('first');
    io.resolve('C:/project.subtool');await Promise.all([first,second]);
    expect(savedText(desk.writeProject.mock.calls[1])).toBe('second');expect(isProjectDirty()).toBe(false);
  });

  it('returns null on write rejection and allows a later retry',async()=>{
    await Project.saveAs();State.cues[0].text='unsaved';
    desk.writeProject.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(Project.save()).resolves.toBeNull();expect(isProjectDirty()).toBe(true);
    await expect(Project.save()).resolves.toBe('C:/project.subtool');expect(isProjectDirty()).toBe(false);
  });

  it('treats deleting all saved content as a change',async()=>{
    await Project.saveAs();State.cues=[];expect(isProjectDirty()).toBe(true);
  });
});

describe('Project 與 History 共用已提交快照',()=>{
  it.each([false,true])('已有預覽 %s：存檔只排除手勢自己的寫入，保留同句背景時間與樣式修改',async hasPreview=>{
    const {beginTimelineGestureLifecycle}=await import('../src/timeline-gesture-transaction.js');
    const cue=State.cues[0];
    State.tracks.push({name:'second',fontSize:60,visible:true,locked:false});State.trackCount=2;History.reset();
    const gesture=beginTimelineGestureLifecycle({mode:'move',targets:[{target:cue,fields:['start','end','track','style']}],effects:{
      beginPreview:targets=>History.beginPreview(targets),canEdit:()=>!State.tracks[0].locked,
    }});
    gesture.startPreview();if(hasPreview)gesture.preview(()=>{cue.start=3;cue.end=4;cue.track=1;cue.style={fontSize:80};});
    cue.start=1.5;cue.end=2.5;cue.style={fontSize:110};History.record('background');
    await Project.saveAs();const saved=decode(desk.saveProject.mock.calls.at(-1)[1]);
    expect(saved.cues[0]).toMatchObject({start:1.5,end:2.5,track:1,style:{fontSize:110}});
    State.tracks[0].locked=true;gesture.commit();
    expect(cue).toMatchObject({start:1.5,end:2.5,track:0,style:{fontSize:110}});
    expect(isProjectDirty()).toBe(true);await Project.save();
    expect(decode(desk.writeProject.mock.calls.at(-1)[1]).cues[0]).toMatchObject({start:1.5,end:2.5,track:1,style:{fontSize:110}});
  });
  it('save/saveAs、自動備份與 dirty 排除草稿，仍保存期間完成的背景工作',async()=>{
    const audio={id:'runtime-audio',audioSourceId:'audio',name:'voice',path:'C:/voice.wav',duration:4,in:0,out:4,offset:3,height:64};
    runtime.sources=[audio];State.externalAudioState=[audio];
    History.reset();
    vi.useFakeTimers();
    await Project.saveAs();
    const cue=State.cues[0],clip=State.clips[0];
    const finish=History.beginPreview([
      {target:cue,fields:['text','style']},{target:clip,fields:['offset','posX']},
      {target:audio,fields:['offset','height']},
    ]);
    const finishAudio=History.beginAudioPreview(State.audioProject);
    cue.text='之後會取消';cue.style={fontSize:99};clip.offset=20;clip.posX=0.2;
    audio.offset=30;audio.height=120;State.duration=40;State.audioProject.buses[0].muted=true;
    expect(isProjectDirty()).toBe(false);
    State.notes.push({id:'background',time:2,text:'背景完成'});
    History.record('背景工作');
    expect(isProjectDirty()).toBe(true);
    await Project.save();
    const saved=decode(desk.writeProject.mock.calls.at(-1)[1]);
    expect(saved.cues).toEqual([{start:1,end:2,text:'已提交',track:1,timed:true}]);
    expect(saved.clips[0]).toMatchObject({offset:0,posX:0.5});
    expect(saved.externalAudioSources[0]).toMatchObject({offset:3,height:64});
    expect(saved.audioProject.buses[0].muted).toBe(false);
    expect(saved.duration).toBe(10);
    expect(saved.notes[0].text).toBe('背景完成');
    expect(isProjectDirty()).toBe(false);
    await Project.saveAs();
    expect(decode(desk.saveProject.mock.calls.at(-1)[1])).toEqual(saved);
    await vi.advanceTimersByTimeAsync(3*60*1000);
    expect(desk.writeProject.mock.calls.at(-1)[0]).toContain('.subtool_AutoSave');
    expect(decode(desk.writeProject.mock.calls.at(-1)[1])).toEqual(saved);
    cue.text='已提交';delete cue.style;clip.offset=0;delete clip.posX;
    audio.offset=3;audio.height=64;State.duration=10;State.audioProject.buses[0].muted=false;
    finish();finishAudio();
    expect(isProjectDirty()).toBe(false);
    cue.text='確認後的編輯';History.record('確認');
    expect(isProjectDirty()).toBe(true);
    await Project.save();
    expect(decode(desk.writeProject.mock.calls.at(-1)[1]).cues[0].text).toBe('確認後的編輯');
  });

  it('預覽新增的字幕和影片不使空專案變 dirty，也不進存檔',async()=>{
    State.cues=[];State.clips=[];State.audioProject=null;State.duration=0;History.reset();
    const cue={id:'draft',text:'草稿',start:0,end:2,track:0};
    const clip={id:'draft-clip',name:'draft',dur:3,in:0,out:3,offset:0};
    State.cues.push(cue);State.clips.push(clip);State.duration=3;
    const finish=History.beginPreview([{target:cue,added:true},{target:clip,added:true}]);
    expect(isProjectDirty()).toBe(false);
    await Project.saveAs();
    expect(decode(desk.saveProject.mock.calls[0][1])).toMatchObject({cues:[],clips:[],duration:0});
    finish();
    expect(isProjectDirty()).toBe(true);
  });

  it('外部素材重新序列化後，以持久來源身分投影草稿，保留尚未重連素材',async()=>{
    State.clips=[];
    const source={audioSourceId:'offline',name:'離線',path:'C:/offline.wav',duration:5,in:0,out:5,offset:2,height:64};
    Project.apply({app:'SUB Tool',version:3,fps:24,tracks:State.tracks,cues:[],clips:[],externalAudioSources:[source]});
    const current=()=>State.externalAudioState[0];
    const finish=History.beginPreview([{target:current(),fields:['height'],resolveTarget:current}]);
    State.externalAudioState=[{...current(),height:120}];
    await Project.saveAs();
    expect(decode(desk.saveProject.mock.calls[0][1]).externalAudioSources[0]).toMatchObject(source);
    finish();
  });

  it('同名不同群組樣式在專案嵌入與重新匯入後各自保留',async()=>{
    styles.savePresets([{name:'對白',group:'A',style:{fontSize:80}},{name:'對白',group:'B',style:{fontSize:90}}]);
    State.tracks=[{name:'A',fontSize:80},{name:'B',fontSize:90}];State.trackCount=2;
    await Project.saveAs();
    const saved=decode(desk.saveProject.mock.calls[0][1]);
    expect(saved.usedPresets.map(p=>[p.group,p.name])).toEqual([['A','對白'],['B','對白']]);
    styles.savePresets([{name:'對白',group:'A',style:{fontSize:80}}]);
    Project.apply(saved);
    expect(styles.getPresets().map(p=>[p.group,p.name,p.style.fontSize])).toEqual([['A','對白',80],['B','對白',90]]);
  });

  it('專案樣式輸入排除毀損欄位，保留合法的歷史座標和角度',()=>{
    Project.apply({app:'SUB Tool',version:3,fps:24,
      tracks:[{name:'legacy',posX:'30',posPct:91.2037,fontSize:400,color:'bad',angle:720}],
      cues:[{start:0,end:1,text:'safe',track:1,style:{posY:'broken',posX:-5,angle:450,color:'#FF0000'}}],clips:[]});
    expect(State.tracks[0]).toMatchObject({fontSize:400,posY:91.2037,angle:720});
    expect(State.tracks[0]).not.toHaveProperty('posX');
    expect(State.tracks[0]).not.toHaveProperty('color');
    expect(State.cues[0].style).toEqual({posX:-5,angle:450,color:'#ff0000'});
  });

  it.each([-1,0,'broken'])('舊 fontScale %s 同樣通過 canonical 字級驗證',fontScale=>{
    Project.apply({app:'SUB Tool',version:1,tracks:[{name:'legacy',fontScale}],cues:[],clips:[]});
    expect(State.tracks[0]).not.toHaveProperty('fontSize');
    expect(styles.effStyle(null,State.tracks[0]).fontSize).toBe(styles.STYLE_DEFAULTS.fontSize);
  });

  it('apply 取代專案到媒體尚未就緒期間，舊合併 token 不能覆寫前一專案步驟',()=>{
    State.cues[0].style={fontSize:88};
    const owner=History.recordCoalesced('修改字幕樣式');
    const oldEntry=History.stack[History.hi];
    Project.apply({app:'SUB Tool',version:3,fps:24,tracks:[{name:'new'}],
      cues:[{start:0,end:2,text:'新專案',track:1}],clips:[]});
    State.cues[0].style={fontSize:92};
    History.recordCoalesced('修改字幕樣式',owner);
    expect(History.stack).toHaveLength(3);
    expect(oldEntry.snap.cues[0]).toMatchObject({text:'已提交',style:{fontSize:88}});
    expect(History.stack[History.hi].snap.cues[0]).toMatchObject({text:'新專案',style:{fontSize:92}});
  });
});

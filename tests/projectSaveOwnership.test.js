// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime=vi.hoisted(()=>({sources:[],time:0}));
vi.mock('../src/media.js',()=>({Media:{
  displayTime:()=>runtime.time,externalAudio:{list:()=>runtime.sources},reset:vi.fn(),seek:vi.fn(),
}}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn()}));
vi.mock('../src/notes.js',()=>({renderNotes:vi.fn()}));
vi.mock('../src/ui.js',()=>({renderCurrentTimecode:vi.fn(),setStatus:vi.fn(),showToast:vi.fn(),openModal:vi.fn(),closeModal:vi.fn()}));

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

  it('Undo 後外部音訊尚在非同步重建時，History 與實際存檔仍保留期望來源',async()=>{
    const source={audioSourceId:'restore-me',name:'旁白',path:'C:/voice.wav',duration:8,in:0,out:8,offset:0};
    runtime.sources=[];State.externalAudioState=[source];Project.establishCleanBaseline();History.reset();
    State.externalAudioState=[];History.record('刪除旁白');
    History.undo();
    expect(State.externalAudioState.map(item=>item.audioSourceId)).toEqual(['restore-me']);
    expect(runtime.sources).toEqual([]); // 底層音訊仍在非同步重建。
    expect(History.snap().externalAudioState.map(item=>item.audioSourceId)).toEqual(['restore-me']);
    await Project.saveAs();
    expect(decode(desk.saveProject.mock.calls[0][1]).externalAudioSources.map(item=>item.audioSourceId)).toEqual(['restore-me']);
    expect(isProjectDirty()).toBe(false);
  });

  it('網頁下載在 JSON 開頭寫入建置版本，明確標示無法取得電腦名稱且不影響 dirty',async()=>{
    vi.resetModules();delete window.subtool;
    vi.stubGlobal('__APP_VERSION__','8.6.7');
    const util=await import('../src/util.js');
    const downloaded=vi.spyOn(util,'downloadBytes').mockImplementation(()=>{});
    const browser=await import('../src/project.js');
    try{
      await browser.Project.saveAs();
      const bytes=downloaded.mock.calls[0][0];
      const text=Buffer.from(bytes).subarray(2).toString('utf16le');
      expect(text).toMatch(/^\{\n "SUB Tool": "8\.6\.7",\n "User Name": "網頁版（無法取得電腦名稱）",/);
      expect(JSON.parse(text).version).toBe(3);
      expect(browser.isProjectDirty()).toBe(false);
    }finally{browser.resetProject();downloaded.mockRestore();vi.unstubAllGlobals();}
  });

  it.each([false,true])('變速片段固定=%s 保存時間軸長度與來源幀，不保存 PNG 預覽快取',async frozen=>{
    State.cues=[];
    const clip={id:'speed',path:'C:/movie.mp4',dur:6,in:0,out:6,offset:2,vtrack:0,speed:2,reverse:true};
    if(frozen) Object.assign(clip,{freezeTime:1,freezeWeb:{url:'subtool-local://frame'}});
    State.clips=[clip];State.duration=5;History.reset();
    await Project.saveAs();
    const saved=decode(desk.saveProject.mock.calls[0][1]);
    expect(saved.duration).toBe(5);
    expect(saved.clips[0]).toMatchObject({path:'C:/movie.mp4',in:0,out:6,offset:2,speed:2,reverse:true});
    expect(saved.clips[0]).not.toHaveProperty('freezeWeb');
    if(frozen) expect(saved.clips[0].freezeTime).toBe(1);
    else expect(saved.clips[0]).not.toHaveProperty('freezeTime');
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

  it.each(['reset', 'open', 'saveAs', 'current'])('自動備份完成回報保留原工作區及儲存目標資格：%s', async change => {
    const { setStatus } = await import('../src/ui.js');
    vi.useFakeTimers();
    await Project.saveAs();
    const pending = deferred();
    desk.writeProject.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(desk.writeProject).toHaveBeenCalledOnce();
    const [backupPath, b64] = desk.writeProject.mock.calls[0];
    expect(backupPath).toContain('C:/.subtool_AutoSave/project_');
    expect([...Buffer.from(b64, 'base64').subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(decode(b64).cues[0].text).toBe('original');

    if (change === 'reset') resetProject();
    else if (change === 'open') await Project.loadDesktop({ path: 'C:/opened/new.subtool',
      b64: Buffer.from(JSON.stringify({ app: 'SUB Tool', version: 3, fps: 24, media: {}, clips: [],
        tracks: [{ name: '新專案' }], cues: [], notes: [] })).toString('base64') });
    else if (change === 'saveAs') {
      desk.saveProject.mockResolvedValueOnce('C:/renamed/new.subtool');
      await Project.saveAs();
    }
    const directory = getProjectDir(), dirty = isProjectDirty();
    setStatus('目前工作區就緒', 'ok');
    pending.resolve(backupPath);
    await Promise.resolve();
    await Promise.resolve();
    expect(setStatus.mock.calls.at(-1)).toEqual(change === 'current'
      ? ['自動備份：' + backupPath.split('/').pop(), 'ok'] : ['目前工作區就緒', 'ok']);
    expect(getProjectDir()).toBe(directory);
    expect(isProjectDirty()).toBe(dirty);
    expect(desk.writeProject).toHaveBeenCalledOnce();
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

  it('存檔等待期間的播放長度回報不覆蓋較新編輯或改寫存檔快照',async()=>{
    const {Seq}=await import('../src/sequence.js');
    State.clips=[{id:'clip',name:'movie',path:'C:/movie.mp4',dur:10,in:0,out:10,offset:0,vtrack:0}];
    History.reset();
    await Project.saveAs();
    const io=deferred();desk.writeProject.mockReturnValueOnce(io.promise);
    State.cues[0].text='準備保存';const saving=Project.save();
    await vi.waitFor(()=>expect(desk.writeProject).toHaveBeenCalledOnce());
    Seq.observeSourceDuration(State.clips[0],12);
    State.cues[0].text='等待期間更新';
    io.resolve('C:/project.subtool');await saving;
    const saved=decode(desk.writeProject.mock.calls[0][1]);
    expect(saved.cues[0].text).toBe('準備保存');
    expect(saved.clips[0]).toMatchObject({dur:10,out:10});
    expect(State.clips[0]).toMatchObject({dur:10,out:10});
    expect(Seq.sourceDuration(State.clips[0])).toBe(12);
    expect(isProjectDirty()).toBe(true);
    await Project.save();expect(isProjectDirty()).toBe(false);
    expect(decode(desk.writeProject.mock.calls[1][1]).clips[0]).toMatchObject({dur:10,out:10});
  });

  it('returns null on write rejection and allows a later retry',async()=>{
    const {showToast}=await import('../src/ui.js');
    await Project.saveAs();State.cues[0].text='unsaved';
    showToast.mockClear();
    desk.writeProject.mockRejectedValueOnce(new Error('C:/private/secret: disk unavailable'));
    await expect(Project.save()).resolves.toBeNull();expect(isProjectDirty()).toBe(true);
    expect(showToast).toHaveBeenCalledWith('儲存專案失敗，請嘗試「另存新檔」');
    expect(showToast.mock.calls.flat().join(' ')).not.toContain('C:/private/secret');
    await expect(Project.save()).resolves.toBe('C:/project.subtool');expect(isProjectDirty()).toBe(false);
  });

  it.each(['save','saveAs'])('%s 收到目的檔衝突時顯示提示並維持未儲存狀態',async kind=>{
    const {showToast}=await import('../src/ui.js');
    await Project.saveAs();
    State.cues[0].text='尚未儲存的變更';
    const directory=getProjectDir();
    showToast.mockClear();
    (kind==='save'?desk.writeProject:desk.saveProject).mockResolvedValueOnce({code:'PROJECT_DESTINATION_CHANGED'});
    await expect(kind==='save'?Project.save():Project.saveAs()).resolves.toBeNull();
    expect(showToast).toHaveBeenCalledWith('專案檔在儲存期間已變更，請另存新檔');
    expect(isProjectDirty()).toBe(true);
    expect(getProjectDir()).toBe(directory);
  });

  it('舊專案的衝突回覆晚到時，不對新工作區顯示錯誤',async()=>{
    const {showToast}=await import('../src/ui.js');
    await Project.saveAs();State.cues[0].text='尚未儲存';
    const pending=deferred();desk.writeProject.mockReturnValueOnce(pending.promise);
    const saving=Project.save();
    await vi.waitFor(()=>expect(desk.writeProject).toHaveBeenCalledOnce());
    resetProject();showToast.mockClear();
    pending.resolve({code:'PROJECT_DESTINATION_CHANGED'});
    await expect(saving).resolves.toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('收到未知儲存結果時不把物件當作檔案路徑或標記已儲存',async()=>{
    await Project.saveAs();State.cues[0].text='未儲存';
    desk.writeProject.mockResolvedValueOnce({code:'unexpected',message:'sensitive'});
    await expect(Project.save()).resolves.toBeNull();
    expect(isProjectDirty()).toBe(true);
  });

  it('自動備份遇目的檔衝突時提示失敗，不將錯誤物件當成備份成功',async()=>{
    const {showToast,setStatus}=await import('../src/ui.js');
    vi.useFakeTimers();
    await Project.saveAs();
    State.cues[0].text='尚未儲存';
    showToast.mockClear();setStatus.mockClear();
    desk.writeProject.mockResolvedValueOnce({code:'PROJECT_DESTINATION_CHANGED'});
    await vi.advanceTimersByTimeAsync(3*60*1000);
    expect(showToast).toHaveBeenCalledWith('自動備份失敗：專案檔在儲存期間已變更，請另存新檔');
    expect(setStatus).not.toHaveBeenCalledWith(expect.stringContaining('自動備份：'), 'ok');
    expect(isProjectDirty()).toBe(true);
  });

  it.each(['null','unknown','rejected','throw'])('自動備份收到 %s 失敗結果時在狀態列回報，不靜默或變更儲存基準',async outcome=>{
    const {showToast,setStatus}=await import('../src/ui.js');
    vi.useFakeTimers();await Project.saveAs();State.cues[0].text='仍未儲存';
    showToast.mockClear();setStatus.mockClear();
    if(outcome==='rejected')desk.writeProject.mockRejectedValueOnce(new Error('NAS write failed'));
    else if(outcome==='throw')desk.writeProject.mockImplementationOnce(()=>{throw new Error('write unavailable');});
    else desk.writeProject.mockResolvedValueOnce(outcome==='null'?null:{code:'UNSAFE_PROJECT_OUTPUT'});
    await vi.advanceTimersByTimeAsync(3*60*1000);
    expect(setStatus).toHaveBeenCalledWith('自動備份失敗，請手動儲存專案','err');
    expect(setStatus).not.toHaveBeenCalledWith(expect.stringContaining('自動備份：'),'ok');
    expect(showToast).not.toHaveBeenCalled();
    expect(isProjectDirty()).toBe(true);
    expect(savedText(desk.writeProject.mock.calls[0])).toBe('仍未儲存');
    expect(getProjectDir()).toBe('C:/');
  });

  it.each(['reset','open','saveAs'])('自動備份的舊失敗在 %s 後抵達，不覆寫新工作區狀態',async change=>{
    const {setStatus}=await import('../src/ui.js');
    vi.useFakeTimers();await Project.saveAs();
    const pending=deferred();desk.writeProject.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(3*60*1000);
    if(change==='reset')resetProject();
    else if(change==='open')await Project.loadDesktop({path:'C:/opened/new.subtool',
      b64:Buffer.from(JSON.stringify({app:'SUB Tool',version:3,fps:24,media:{},clips:[],
        tracks:[{name:'新專案'}],cues:[],notes:[]})).toString('base64')});
    else {desk.saveProject.mockResolvedValueOnce('C:/renamed/new.subtool');await Project.saveAs();}
    const directory=getProjectDir(),dirty=isProjectDirty();
    setStatus('目前工作區就緒','ok');pending.resolve(null);
    await Promise.resolve();await Promise.resolve();
    expect(setStatus.mock.calls.at(-1)).toEqual(['目前工作區就緒','ok']);
    expect(getProjectDir()).toBe(directory);expect(isProjectDirty()).toBe(dirty);
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
    Project.establishCleanBaseline();
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

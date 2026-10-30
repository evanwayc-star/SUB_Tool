// @vitest-environment jsdom
import {afterAll,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State,History,Model,StylePanelController,styles,ui;
const effective=cue=>styles.effStyle(cue||State.cues[0],State.tracks[(cue||State.cues[0]).track||0]);
const inputSize=value=>{const input=document.getElementById('tsSize');input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));};

beforeAll(async()=>{
  vi.useFakeTimers();
  const parsed=new DOMParser().parseFromString(fs.readFileSync(path.join(process.cwd(),'index.html'),'utf8'),'text/html');
  document.body.innerHTML=parsed.body.innerHTML;
  HTMLElement.prototype.scrollIntoView=vi.fn();
  HTMLMediaElement.prototype.pause=vi.fn();
  HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}})}, {get:(target,key)=>target[key]||(()=>{}),set:(target,key,value)=>(target[key]=value,true)});
  ({State}=await import('../src/state.js'));
  ({History}=await import('../src/history.js'));
  Model=await import('../src/subtitle-model.js');
  styles=await import('../src/substyle.js');
  ui=await import('../src/ui.js');
  ({StylePanelController}=await import('../src/style-panel-controller.js'));
  const noop=()=>{};
  StylePanelController.bindStylePanelEvents({renderAll:noop,renderVideoSub:noop,refreshMpvSubs:noop,drawTimeline:noop,refreshStyleSummaries:noop,initPresetLibrary:noop,styleChanged:noop});
  const {initPresetLibrary}=await import('../src/preset-library.js');
  initPresetLibrary({styleChanged:noop});
});
beforeEach(()=>{
  vi.advanceTimersByTime(501);
  ui.closeModal();
  styles.savePresets([]);
  Object.assign(State,{tracks:[{name:'src',fontSize:80,color:'#ff0000',visible:true,locked:false},{name:'dst',fontSize:60,visible:true,locked:false}],cues:[{id:'cue',start:1,end:2,text:'copy',track:0}],notes:[],listTrack:0,selectedId:'cue',selectedIds:['cue'],presetEdit:null,clips:[],externalAudioState:[],videoTracks:[{name:'v',visible:true}],fps:25,dropFrame:false,clipboard:[]});
  History.reset(); StylePanelController.renderTrackStyle();
});
afterAll(()=>{ui.closeModal();vi.clearAllTimers();vi.useRealTimers();});

describe('字幕樣式 public caller 與 snapshot ownership',()=>{
  it.each([false,true])('外音 2x reverse=%s 時間軸區塊寬度及波形採來源映射',async reverse=>{
    const {Media,Wave}=await import('../src/media.js');
    const {drawTimeline}=await import('../src/timeline-renderer.js');
    const asset=Media.externalAudio.add({audioSourceId:'speed-wave',offset:10,in:2,out:12,duration:16,speed:2,reverse});
    const ctx=new Proxy({moveTo:vi.fn(),lineTo:vi.fn()}, {get:(target,key)=>target[key]||(()=>{}),set:(target,key,value)=>(target[key]=value,true)});
    const originalContext=HTMLCanvasElement.prototype.getContext;
    const resolution=Wave.resolution;
    const scroll=document.getElementById('tlScroll');
    const width=Object.getOwnPropertyDescriptor(scroll,'clientWidth');
    const view={pxPerSec:State.pxPerSec,viewStart:State.viewStart};
    asset.peaks=new Float32Array(34);asset.peaks[4]=-.2;asset.peaks[5]=.2;asset.peaks[24]=-1;asset.peaks[25]=1;
    const wave=vi.spyOn(Wave,'getSourceWaveform').mockReturnValue({peaks:asset.peaks,selection:'mix',fallback:false});
    HTMLCanvasElement.prototype.getContext=function(...args){return this.classList.contains('audio-clip-wave')?ctx:originalContext.apply(this,args);};
    try{
      Object.defineProperty(scroll,'clientWidth',{configurable:true,value:300});
      Object.assign(State,{pxPerSec:10,viewStart:0});Wave.resolution=1;
      drawTimeline();
      const block=document.querySelector(`[data-audio-asset-id="${asset.id}"].external-audio-block`);
      expect(block.dataset.audioStart).toBe('10');expect(block.dataset.audioEnd).toBe('15');
      expect(block.style.width).toBe('50px');
      const height=block.querySelector('canvas').height/devicePixelRatio;
      expect(ctx.moveTo.mock.calls[0][0]).toBe(.5);
      expect(ctx.moveTo.mock.calls[0][1]).toBeCloseTo(height/2-height*1.2*(reverse?1:.2),6);
    }finally{
      Media.externalAudio.remove(asset);wave.mockRestore();Wave.resolution=resolution;
      HTMLCanvasElement.prototype.getContext=originalContext;Object.assign(State,view);
      if(width) Object.defineProperty(scroll,'clientWidth',width);else delete scroll.clientWidth;
    }
  });
  it('右鍵跨軌移動保留每句原有外觀，Undo/Redo 還原樣式與軌道',async()=>{
    const {moveSelectedToTrack}=await import('../src/timeline-renderer.js');
    State.trackCount=2;
    State.cues.push({id:'second',start:3,end:4,text:'第二句',track:1,style:{color:'#00ff00',angle:15,bgBox:true}});
    State.selectedIds=['cue','second'];
    const before=State.cues.map(c=>({track:c.track,style:effective(c)}));
    History.reset();
    moveSelectedToTrack(1);
    expect(State.cues.map(effective)).toEqual(before.map(c=>c.style));
    expect(State.cues.map(c=>c.track)).toEqual([1,1]);
    expect(State.cues[1].style).toEqual({color:'#00ff00',angle:15,bgBox:true});
    History.undo();
    expect(State.cues.map(c=>c.track)).toEqual([0,1]);
    expect(State.cues.map(effective)).toEqual(before.map(c=>c.style));
    History.redo();
    expect(State.cues.map(c=>c.track)).toEqual([1,1]);
    expect(State.cues.map(effective)).toEqual(before.map(c=>c.style));
  });
  it('同軌移動不改單句樣式或新增 Undo，跨鎖定軌移動整批拒絕',async()=>{
    const {moveSelectedToTrack}=await import('../src/timeline-renderer.js');
    State.trackCount=2;State.cues[0].style={fontSize:80};
    const ownStyle=State.cues[0].style,steps=History.stack.length;
    moveSelectedToTrack(0);
    expect(State.cues[0].style).toBe(ownStyle);
    expect(History.stack).toHaveLength(steps);
    State.tracks[1].locked=true;
    moveSelectedToTrack(1);
    expect(State.cues[0].track).toBe(0);
    expect(History.stack).toHaveLength(steps);
  });
  it.each([23.976,24,25,29.97,30])('FPS %s 的 timed 區間至少一格，未定時字幕保持原值',fps=>{
    State.fps=fps;
    State.cues=[{id:'one',start:2/30,end:3/30,text:'一格',track:0},
      {id:'untimed',start:2/30,end:2/30,text:'未定時',track:0,timed:false}];
    const untimed={...State.cues[1]};
    Model.snapAllCuesToFrames();
    const exact=fps===23.976?24000/1001:fps===29.97?30000/1001:fps;
    const startFrame=Math.round(State.cues[0].start*exact),endFrame=Math.round(State.cues[0].end*exact);
    expect(endFrame-startFrame).toBeGreaterThanOrEqual(1);
    expect(State.cues[0].start*exact).toBeCloseTo(startFrame,8);
    expect(State.cues[0].end*exact).toBeCloseTo(endFrame,8);
    expect(State.cues[1]).toEqual(untimed);
  });
  it('管理視窗套預設到非預設軌，仍達到完整目標外觀',()=>{
    State.tracks[0].fontSize=90;
    document.getElementById('tsPresetMgr').click();
    document.querySelector('[data-pre-apply="0"]').click();
    expect(effective().fontSize).toBe(80);
    expect(effective().color).toBe('#ffffff');
  });
  it('管理視窗的草稿同步也使用字幕真正所屬軌',async()=>{
    styles.savePresets([{name:'copy',style:{...styles.STYLE_DEFAULTS}}]);
    State.cues[0].style={...styles.STYLE_DEFAULTS};
    document.getElementById('tsPresetMgr').click();
    document.querySelector('[data-pre-edit="0"]').click();
    State.presetEdit.draft.color='#00ff00';
    document.getElementById('tsEditDone').click();
    await vi.waitFor(()=>expect(State.presetEdit).toBeNull());
    expect(effective().fontSize).toBe(80);
    expect(effective().color).toBe('#00ff00');
  });
  it('複製後來源軌更改樣式，跨軌貼上保留copy瞬間外觀',()=>{
    Model.copyCues(); State.tracks[0].fontSize=120; State.listTrack=1; Model.pasteCues();
    expect(effective(State.cues.find(c=>c.id!=='cue')).fontSize).toBe(80);
  });
  it('來源軌被刪除後，貼上仍保留其原樣式與未定時狀態',()=>{
    State.cues[0].timed=false;
    Model.copyCues(); State.tracks.shift(); State.cues=[]; State.listTrack=0; Model.pasteCues();
    expect(effective().fontSize).toBe(80);
    expect(State.cues[0].timed).toBe(false);
  });
  it('同索引但已換專案的軌，不能冒充clipboard來源',()=>{
    Model.copyCues(); State.tracks=[{fontSize:110}]; State.cues=[]; State.listTrack=0; Model.pasteCues();
    expect(effective().fontSize).toBe(80);
  });
  it('同一個实际軌仍保留繼承與獨立override',()=>{
    State.cues[0].style={color:'#00ff00'};
    Model.copyCues(); State.tracks[0].fontSize=120; Model.pasteCues();
    const pasted=State.cues.find(c=>c.id!=='cue');
    expect(effective(pasted).fontSize).toBe(120);
    expect(pasted.style).toEqual({color:'#00ff00'});
    pasted.style.color='#0000ff';expect(State.clipboard[0].style.color).toBe('#00ff00');
  });
  it('連續樣式input只占一步Undo，timer不延後讀State',()=>{
    inputSize(88);inputSize(92);expect(History.stack).toHaveLength(2);
    History.undo();expect(effective().fontSize).toBe(80);
    vi.advanceTimersByTime(501);expect(History.stack).toHaveLength(2);
    History.redo();expect(effective().fontSize).toBe(92);
  });
  it('note介入後Undo只撤note，樣式仍留在原步驟',()=>{
    inputSize(88);State.notes.push({id:'n',time:2,text:'later'});History.record('note edit');
    vi.advanceTimersByTime(501);History.undo();
    expect(State.notes).toHaveLength(0);expect(effective().fontSize).toBe(88);
    History.undo();expect(effective().fontSize).toBe(80);
  });
  it('另一筆record介入後的新input不能amend原樣式步驟',()=>{
    inputSize(88);State.notes.push({id:'n',time:2,text:'later'});History.record('note edit');inputSize(92);
    expect(History.stack).toHaveLength(4);
    History.undo();expect(effective().fontSize).toBe(88);expect(State.notes).toHaveLength(1);
    History.undo();expect(effective().fontSize).toBe(88);expect(State.notes).toHaveLength(0);
  });
  it('回開始值不留下空Undo步驟',()=>{
    inputSize(88);inputSize(80);expect(History.stack).toHaveLength(1);expect(History.hi).toBe(0);
  });
  it('Undo之後舊owner不能amend新head',()=>{
    inputSize(88);History.undo();inputSize(92);expect(History.stack).toHaveLength(2);
    History.undo();expect(effective().fontSize).toBe(80);
  });
  it('reset撤銷先前input owner，新樣式有獨立Undo',()=>{
    inputSize(88);History.reset();inputSize(92);expect(History.stack).toHaveLength(2);
    History.undo();expect(effective().fontSize).toBe(88);
  });
  it('同名不同資料夾的option套用自己的preset',()=>{
    styles.savePresets([{name:'same',group:'A',style:{fontSize:40}},{name:'same',group:'B',style:{fontSize:90}}]);
    StylePanelController.renderTrackStyle();const sel=document.getElementById('tsPresetSel');
    sel.selectedIndex=[...sel.options].findIndex(o=>o.parentElement.label==='📁 B');sel.dispatchEvent(new Event('change',{bubbles:true}));
    expect(effective().fontSize).toBe(90);
  });
  it('毀損preset欄位在寫入前排除，選取不污染State或崩潰',()=>{
    styles.savePresets([{name:'bad',style:{posX:'30',bold:'false',color:'red',align:'bogus',fontSize:Infinity}}]);
    expect(styles.getPresets()[0].style).toEqual({});StylePanelController.renderTrackStyle();
    const sel=document.getElementById('tsPresetSel');sel.value=styles.presetIdentity(styles.getPresets()[0]);sel.dispatchEvent(new Event('change',{bubbles:true}));
    expect(()=>StylePanelController.renderTrackStyle()).not.toThrow();expect(typeof effective().posX).toBe('number');
  });
});

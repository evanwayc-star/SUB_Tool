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
  it('管理視窗套預設到非預設軌，仍達到完整目標外觀',()=>{
    State.tracks[0].fontSize=90;
    document.getElementById('tsPresetMgr').click();
    document.querySelector('[data-pre-apply="0"]').click();
    expect(effective().fontSize).toBe(80);
    expect(effective().color).toBe('#ffffff');
  });
  it('管理視窗的草稿同步也使用字幕真正所屬軌',()=>{
    styles.savePresets([{name:'copy',style:{...styles.STYLE_DEFAULTS}}]);
    State.cues[0].style={...styles.STYLE_DEFAULTS};
    document.getElementById('tsPresetMgr').click();
    document.querySelector('[data-pre-edit="0"]').click();
    State.presetEdit.draft.color='#00ff00';
    document.getElementById('tsEditDone').click();
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

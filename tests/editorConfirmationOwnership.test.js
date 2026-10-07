// @vitest-environment jsdom
import {afterAll,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let State,History,StylePanelController,styles,ui;
const effective=cue=>styles.effStyle(cue||State.cues[0],State.tracks[(cue||State.cues[0]).track||0]);

beforeAll(async()=>{
  vi.useFakeTimers();
  const parsed=new DOMParser().parseFromString(fs.readFileSync(path.join(process.cwd(),'index.html'),'utf8'),'text/html');
  document.body.innerHTML=parsed.body.innerHTML;
  HTMLElement.prototype.scrollIntoView=vi.fn();
  HTMLMediaElement.prototype.pause=vi.fn();
  HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}})}, {get:(target,key)=>target[key]||(()=>{}),set:(target,key,value)=>(target[key]=value,true)});
  ({State}=await import('../src/state.js'));
  ({History}=await import('../src/history.js'));
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

describe('editor confirmation ownership and invalidation',()=>{
  it('old clear-all confirmation preserves notes of replacement workspace',async()=>{
    const Notes=await import('../src/notes.js');
    State.notes=[{id:'old',time:1,text:'old'}];Notes.renderNotes();Notes.clearAllNotes();
    State.notes=[{id:'new',time:2,text:'new'}];History.reset();
    [...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent.includes('確定清除')).click();
    expect(State.notes).toEqual([{id:'new',time:2,text:'new'}]);
  });
  it('search drops removed text after normal edit redraw',async()=>{
    const Search=await import('../src/subtitle-search.js');
    const {emit}=await import('../src/events.js');
    State.cues[0].text='needle';Search.searchUpdate('needle');State.cues[0].text='other';emit('render:all');
    expect(Search.getSearchCountText()).toBe('無結果');expect(Search.isSearchHit('cue')).toBe(false);
  });
  it('search one replace rejects stale match now on locked different track',async()=>{
    const Search=await import('../src/subtitle-search.js');
    State.cues[0].text='needle';Search.searchUpdate('needle');State.cues[0].track=1;State.tracks[1].locked=true;
    Search.searchReplace(false,'replaced');expect(State.cues[0].text).toBe('needle');
  });
  it('unify late confirmation preserves style in replacement workspace',()=>{
    State.cues.push({id:'second',start:3,end:4,text:'second',track:0,style:{fontSize:40}});StylePanelController.renderTrackStyle();
    document.getElementById('tsUnify').click();
    State.tracks=[{name:'new',fontSize:110,visible:true,locked:false}];State.cues=[{id:'newcue',start:1,end:2,text:'new',track:0,style:{fontSize:40}}];History.reset();
    [...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent.includes('套用到全部')).click();
    expect(effective().fontSize).toBe(40);
  });
  it.each(['tsUnify','tsUnifyExclude'])('%s rejects a track scope changed by a background cue addition',control=>{
    const other={id:'other',start:3,end:4,text:'other',track:0,style:{fontSize:40}};
    State.cues.push(other);StylePanelController.renderTrackStyle();
    document.getElementById(control).click();
    const added={id:'added',start:5,end:6,text:'added',track:0,style:{fontSize:30}};
    State.cues.push(added);
    [...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent.includes('套用到全部')).click();
    expect(effective(other).fontSize).toBe(40);expect(effective(added).fontSize).toBe(30);
    expect(State.tracks[0].fontSize).toBe(80);expect(History.stack).toHaveLength(1);
  });
  it.each(['tsUnify','tsUnifyExclude'])('%s rejects a replaced cue even when the confirmation count is unchanged',control=>{
    const other={id:'other',start:3,end:4,text:'other',track:0,style:{fontSize:40}};
    State.cues.push(other);StylePanelController.renderTrackStyle();
    document.getElementById(control).click();
    const replacement={...other,style:{fontSize:30}};
    State.cues.splice(State.cues.indexOf(other),1,replacement);
    [...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent.includes('套用到全部')).click();
    expect(effective(replacement).fontSize).toBe(30);expect(State.tracks[0].fontSize).toBe(80);
  });
  it.each(['tsUnify','tsUnifyExclude'])('%s rejects a reduced scope after a background cue removal',control=>{
    const remaining={id:'remaining',start:3,end:4,text:'remaining',track:0,style:{fontSize:40}};
    const removed={id:'removed',start:5,end:6,text:'removed',track:0};
    State.cues.push(remaining,removed);StylePanelController.renderTrackStyle();
    document.getElementById(control).click();State.cues.splice(State.cues.indexOf(removed),1);
    [...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent.includes('套用到全部')).click();
    expect(effective(remaining).fontSize).toBe(40);expect(History.stack).toHaveLength(1);
  });
  it.each(['tsUnify','tsUnifyExclude'])('%s respects a track lock set after opening',control=>{
    const other={id:'other',start:3,end:4,text:'other',track:0,style:{fontSize:40}};
    State.cues.push(other);StylePanelController.renderTrackStyle();
    document.getElementById(control).click();State.tracks[0].locked=true;
    [...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent.includes('套用到全部')).click();
    expect(effective(other).fontSize).toBe(40);expect(History.stack).toHaveLength(1);
  });
  it.each(['tsUnify','tsUnifyExclude'])('%s still applies the confirmed unchanged scope',control=>{
    const other={id:'other',start:3,end:4,text:'other',track:0,style:{fontSize:40,posX:700}};
    State.cues.push(other);StylePanelController.renderTrackStyle();
    document.getElementById(control).click();
    [...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent.includes('套用到全部')).click();
    expect(effective(other).fontSize).toBe(80);
    if(control==='tsUnifyExclude') expect(effective(other).posX).toBe(700);
  });
  it('FPS dialog confirmation preserves a track locked since opening',async()=>{
    const Subio=await import('../src/subio.js');
    Subio.showFpsConvertDialog();vi.advanceTimersByTime(31);
    document.getElementById('fpsFrom').value='30';document.getElementById('fpsTo').value='25';State.tracks[0].locked=true;
    [...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent==='轉換').click();
    expect(State.cues[0].start).toBe(1);expect(State.cues[0].end).toBe(2);
  });
  it.each([
    {from:29.97,to:25,projectFps:25},
    {from:23.976,to:24,projectFps:25},
    {from:30,to:29.97,projectFps:29.97},
    {from:24,to:23.976,projectFps:23.976},
    {from:23.976,to:29.97,projectFps:29.97},
    {from:25,to:29.97,projectFps:29.97},
    {from:25,to:30,projectFps:30},
  ])('FPS dialog uses exact rates for long $from → $to conversions on $projectFps grid',async({from,to,projectFps})=>{
    const Subio=await import('../src/subio.js');
    const {getExactFps,snapTimeToFrame}=await import('../src/time.js');
    State.fps=projectFps;State.dropFrame=projectFps===29.97;
    const cue=State.cues[0];cue.start=600001/getExactFps(from);cue.end=600051/getExactFps(from);
    const expectedStart=snapTimeToFrame(600001/getExactFps(to),projectFps,State.dropFrame);
    const expectedEnd=snapTimeToFrame(600051/getExactFps(to),projectFps,State.dropFrame);
    Subio.showFpsConvertDialog();vi.advanceTimersByTime(31);
    document.getElementById('fpsFrom').value=String(from);document.getElementById('fpsTo').value=String(to);
    [...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent==='轉換').click();
    expect(cue.start).toBeCloseTo(expectedStart,10);expect(cue.end).toBeCloseTo(expectedEnd,10);
    expect(State.fps).toBe(projectFps);
  });
  it('FPS dialog preview shows the same snapped example time as its committed result',async()=>{
    const Subio=await import('../src/subio.js');const {fmtClock}=await import('../src/time.js');
    const cue=State.cues[0];cue.start=3600;cue.end=3602;
    Subio.showFpsConvertDialog();vi.advanceTimersByTime(31);
    const from=document.getElementById('fpsFrom'),to=document.getElementById('fpsTo');
    from.value='23.976';to.value='25';from.dispatchEvent(new Event('change',{bubbles:true}));
    const preview=document.getElementById('fpsPreview').textContent;
    expect(preview).toContain('23.976');expect(preview).toContain('25');
    const example=preview.match(/1:00:00 → (\d{2}:\d{2}:\d{2}\.\d{2,3})/);
    expect(example).not.toBeNull();
    [...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent==='轉換').click();
    expect(example[1]).toBe(fmtClock(cue.start));
  });
  it('FPS dialog leaves equal rates unchanged without recording history',async()=>{
    const Subio=await import('../src/subio.js');const before=structuredClone(State.cues),historyCount=History.stack.length;
    Subio.showFpsConvertDialog();vi.advanceTimersByTime(31);
    document.getElementById('fpsFrom').value='29.97';document.getElementById('fpsTo').value='29.97';
    document.getElementById('fpsFrom').dispatchEvent(new Event('change',{bubbles:true}));
    expect(document.getElementById('fpsPreview').textContent).toContain('無需轉換');
    [...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent==='轉換').click();
    expect(State.cues).toEqual(before);expect(History.stack).toHaveLength(historyCount);expect(State.fps).toBe(25);
  });
  it('track delete confirmation preserves replacement track despite new lock',async()=>{
    const Timeline=await import('../src/timeline-renderer.js');
    Timeline.removeTrack(0);State.tracks=[{name:'new',locked:true},{name:'retained'}];State.trackCount=2;
    State.cues=[{id:'new',track:0,text:'new',start:1,end:2}];History.reset();
    [...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent==='確定刪除').click();
    expect(State.cues).toHaveLength(1);expect(State.tracks[0].name).toBe('new');
  });
  it('negative time shift crossing zero keeps at least one frame',async()=>{
    const Subio=await import('../src/subio.js');State.cues[0].start=.2;State.cues[0].end=.4;
    document.getElementById('tcShiftInput').value='00:00:01:00';document.getElementById('tcShiftSel').value='track';
    Subio.applyTcShift(-1);expect(State.cues[0].start).toBe(0);expect(State.cues[0].end).toBe(.04);
  });
  it.each([
    ['timecode',3.25],['percentage',3.25],['timecode',3.75],['percentage',3.75],
  ])('%s duration extension ends on the last frame before neighbour frame %s',async(mode,neighbourFrame)=>{
    const Subio=await import('../src/subio.js');
    State.fps=29.97;State.dropFrame=true;
    const {getExactFps}=await import('../src/time.js');const exact=getExactFps(State.fps);
    const cue=State.cues[0];cue.start=0;cue.end=2/exact;
    State.cues.push({id:'neighbour',start:neighbourFrame/exact,end:6/exact,text:'next',track:0});
    document.getElementById('tcShiftSel').value='sel';
    document.getElementById('durAdjTcInput').value='00:00:00;02';document.getElementById('durAdjPctInput').value='200';
    if(mode==='timecode') Subio.applyDurAdjTc(1);else Subio.applyDurAdjPct();
    expect(cue.end).toBeCloseTo(3/exact,12);expect(cue.end*exact).toBeCloseTo(3,12);
    expect(cue.end).toBeLessThanOrEqual(State.cues.find(c=>c.id==='neighbour').start);
  });
  it.each(['timecode','percentage'])('%s duration shortening keeps one whole frame after a non-frame cue start',async mode=>{
    const Subio=await import('../src/subio.js');
    State.fps=23.976;const {getExactFps}=await import('../src/time.js');const exact=getExactFps(State.fps);
    const cue=State.cues[0];cue.start=.25/exact;cue.end=4/exact;
    document.getElementById('tcShiftSel').value='sel';
    document.getElementById('durAdjTcInput').value='00:00:00:10';document.getElementById('durAdjPctInput').value='1';
    if(mode==='timecode') Subio.applyDurAdjTc(-1);else Subio.applyDurAdjPct();
    expect(cue.end).toBeCloseTo(2/exact,12);expect(cue.end*exact).toBeCloseTo(2,12);
    expect(cue.end-cue.start).toBeGreaterThanOrEqual(1/exact);
  });
  it.each(['timecode','percentage'])('%s duration adjustment preserves a cue when no full frame fits before its neighbour',async mode=>{
    const Subio=await import('../src/subio.js');const cue=State.cues[0];cue.start=0;cue.end=.08;
    State.cues.push({id:'neighbour',start:.03,end:.4,text:'next',track:0});
    document.getElementById('tcShiftSel').value='sel';
    document.getElementById('durAdjTcInput').value='00:00:00:10';document.getElementById('durAdjPctInput').value='1';
    if(mode==='timecode') Subio.applyDurAdjTc(-1);else Subio.applyDurAdjPct();
    expect(cue.end).toBe(.08);
  });
  it('vertical to horizontal cached DOM measure recomputes widest line',async()=>{
    const {measureSubtitleBackgroundLayouts}=await import('../src/subtitle-background-layout.js');
    const doc=document.implementation.createHTMLDocument('measure');
    const make=doc.createElement.bind(doc);doc.createElement=tag=>{const el=make(tag);if(tag==='span')el.getBoundingClientRect=()=>el.style.writingMode==='vertical-lr'?{width:20,height:el.textContent.length*10}:{width:el.textContent.length*10,height:20};return el;};
    const cues=[{id:'layout',text:'A\nBBBB',track:0}];const track={bgBox:true,vertical:true};
    const vertical=measureSubtitleBackgroundLayouts(cues,[track],{documentRef:doc});track.vertical=false;
    const horizontal=measureSubtitleBackgroundLayouts(cues,[track],{documentRef:doc});
    expect(vertical.layout.lineIndex).toBe(1);expect(horizontal.layout.lineIndex).toBe(1);
  });
  it('custom font completion does not write into newly selected cue',async()=>{
    let complete;const pending=new Promise(resolve=>{complete=resolve});
    window.subtool={importFont:()=>pending,fontsList:async()=>({fonts:[]})};
    const old=State.cues[0];State.cues.push({id:'newselection',text:'later',track:0,start:3,end:4});
    const sel=document.getElementById('tsFont');sel.value='__custom';sel.dispatchEvent(new Event('change',{bubbles:true}));
    State.selectedIds=['newselection'];State.selectedId='newselection';complete('Imported Font');
    await Promise.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();
    expect(old.style?.font).toBeUndefined();expect(State.cues[1].style?.font).toBeUndefined();delete window.subtool;
  });
  it('time inline edit redraws moved ruler triangle',async()=>{
    const Notes=await import('../src/notes.js');const Timeline=await import('../src/timeline-renderer.js');
    State.notes=[{id:'note',time:1,text:'note'}];Notes.renderNotes();const spy=vi.spyOn(document.getElementById('rulerCanvas'),'getContext');
    Timeline.drawRuler();expect(spy).toHaveBeenCalled();spy.mockClear();
    const time=document.querySelector('.nt-time');time.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    const input=time.querySelector('input');input.value='00:00:02:00';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    expect(State.notes[0].time).toBe(2);expect(spy).toHaveBeenCalled();spy.mockRestore();
  });
});

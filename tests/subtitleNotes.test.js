// @vitest-environment jsdom
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

let State, setSelection, History, Menus, Notes, Subtitles, UI;

beforeAll(async()=>{
  vi.useFakeTimers();
  document.body.innerHTML=new DOMParser().parseFromString(fs.readFileSync('index.html','utf8'),'text/html').body.innerHTML;
  Object.defineProperty(HTMLElement.prototype,'innerText',{configurable:true,get(){return this.textContent;},set(value){this.textContent=value;}});
  HTMLElement.prototype.scrollIntoView=vi.fn();
  HTMLMediaElement.prototype.pause=vi.fn();HTMLMediaElement.prototype.load=vi.fn();
  HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}})},
    {get:(target,key)=>target[key]||(()=>{}),set:(target,key,value)=>(target[key]=value,true)});
  ({State,setSelection}=await import('../src/state.js'));
  ({History}=await import('../src/history.js'));
  Menus=await import('../src/menus.js');Notes=await import('../src/notes.js');
  Subtitles=await import('../src/subtitles.js');UI=await import('../src/ui.js');
  const {Media}=await import('../src/media.js');
  vi.spyOn(Media,'displayTime').mockReturnValue(90);
  vi.spyOn(Media,'seek').mockResolvedValue(true);
});

beforeEach(()=>{
  Menus.hideCtx();UI.closeModal();
  Object.assign(State,{cues:[
    {id:'first',track:0,start:1.24,end:2,text:'第一句\n第二行'},
    {id:'second',track:0,start:3.56,end:4,text:'另一句'},
  ],notes:[{id:'existing',time:1.24,text:'原有備註',done:true}],
  tracks:[{name:'字幕 1',visible:true,locked:false}],listTrack:0,trackCount:1,
  clips:[],externalAudioState:[],videoTracks:[{visible:true}],duration:100,fps:25,dropFrame:false});
  setSelection({kind:'sub',ids:[],primary:null});
  document.getElementById('subStyleFilter').value='';
  document.getElementById('toast').textContent='';
  History.reset();Subtitles.renderSubList();Notes.renderNotes();
});

afterAll(()=>{Menus.hideCtx();UI.closeModal();vi.restoreAllMocks();vi.clearAllTimers();vi.useRealTimers();});

function openCueMenu(ids=['first'],target=ids[0]){
  setSelection({kind:'sub',ids,primary:ids[0]});
  Subtitles.renderSubList();
  const row=document.querySelector(`.sub-row[data-id="${target}"]`);
  expect(row).not.toBeNull();
  row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:100}));
  const action=document.querySelector('[data-menu-id="create-notes-from-subtitles"]');
  expect(action).not.toBeNull();expect(action.textContent).toBe('建立備註');
  return action;
}

it('右鍵單句以字幕 IN 與完整文字建立備註，保留同時點既有備註',()=>{
  openCueMenu().click();
  expect(State.notes.map(({time,text,done})=>({time,text,done}))).toEqual([
    {time:1.24,text:'原有備註',done:true},{time:1.24,text:'第一句\n第二行',done:false},
  ]);
  expect(State.notes[1].id).not.toBe('existing');
  expect(document.querySelectorAll('.note-item')).toHaveLength(2);
  expect(document.getElementById('toast').textContent).toContain('已建立 1 條備註');
  expect(History.stack).toHaveLength(2);
});

it('右鍵已多選的字幕保持整組，每句各一備註並以一次 Undo/Redo 往返',()=>{
  const original=structuredClone(State.notes),cues=structuredClone(State.cues);
  openCueMenu(['second','first'],'first').click();
  expect(State.selectedIds).toEqual(['second','first']);
  const created=structuredClone(State.notes);
  expect(created.map(({time,text})=>({time,text}))).toEqual([
    {time:1.24,text:'原有備註'},{time:1.24,text:'第一句\n第二行'},{time:3.56,text:'另一句'},
  ]);
  expect(new Set(created.map(note=>note.id)).size).toBe(3);
  expect(State.cues).toEqual(cues);expect(History.stack).toHaveLength(2);
  History.undo();expect(State.notes).toEqual(original);expect(State.cues).toEqual(cues);
  History.redo();expect(State.notes).toEqual(created);
});

it('右鍵未選中的字幕只替該句建立備註',()=>{
  openCueMenu(['first'],'second').click();
  expect(State.selectedIds).toEqual(['second']);
  expect(State.notes.at(-1)).toMatchObject({time:3.56,text:'另一句',done:false});
  expect(State.notes).toHaveLength(2);
});

it('時間軸字幕右鍵共用整組選取與建立備註入口',()=>{
  setSelection({kind:'sub',ids:['first','second'],primary:'first'});
  const block=document.createElement('div');block.className='cue-block';block.dataset.id='second';
  document.getElementById('tlLayer').appendChild(block);
  try{
    block.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:100}));
    const action=document.querySelector('[data-menu-id="create-notes-from-subtitles"]');
    expect(action).not.toBeNull();action.click();
    expect(State.notes.map(note=>note.time)).toEqual([1.24,1.24,3.56]);
    expect(State.selectedIds).toEqual(['first','second']);expect(History.stack).toHaveLength(2);
  }finally{block.remove();}
});

it.each([null,undefined])('只有有效 IN、OUT=%s 時仍可建立備註',end=>{
  State.cues[0].end=end;State.cues[0]._tempEnd=true;History.reset();
  openCueMenu().click();
  expect(State.notes.at(-1)).toMatchObject({time:1.24,text:'第一句\n第二行',done:false});
  expect(History.stack).toHaveLength(2);
});

it.each([
  {timed:false,start:3.56},
  {start:NaN},
  {start:-1},
])('選取含未定時或無效 IN %j 時整批不建立並明確提示',invalid=>{
  Object.assign(State.cues[1],invalid);History.reset();
  const before=structuredClone(State.notes);
  openCueMenu(['first','second']).click();
  expect(State.notes).toEqual(before);expect(History.stack).toHaveLength(1);
  expect(document.getElementById('toast').textContent).toContain('1 條字幕');
  expect(document.getElementById('toast').textContent).toContain('請先設定時間碼');
  expect(document.getElementById('toast').textContent).toContain('未建立任何備註');
});

it.each(['selection','undo','reset','lock'])('%s 取代右鍵選單資格後不可建立備註',change=>{
  if(change==='undo'){State.cues[0].text='已修改';History.record('修改字幕');}
  const action=openCueMenu();
  if(change==='selection')setSelection({kind:'sub',ids:['second'],primary:'second'});
  if(change==='undo')History.undo();
  if(change==='reset')History.reset();
  if(change==='lock')State.tracks[0].locked=true;
  const before=structuredClone(State.notes),history=History.stack.length;
  action.click();
  expect(State.notes).toEqual(before);expect(History.stack).toHaveLength(history);
});

it.each([['start',5],['text','背景已改文字'],['timed',false]])('選單開啟後同一字幕的 %s 改變，不建立未確認內容', (field,value)=>{
  const action=openCueMenu(['first','second']);
  State.cues[0][field]=value;History.record('背景字幕更新');
  const before=structuredClone(State.notes),history=History.stack.length;
  action.click();
  expect(State.notes).toEqual(before);expect(History.stack).toHaveLength(history);
  expect(document.getElementById('toast').textContent).toContain('字幕已變更');
});

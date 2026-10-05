// @vitest-environment jsdom
import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import fs from 'node:fs';
let State,History,Notes,Settings,UI,Menus,readers,readStarted;
const key=(element,key)=>element.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
beforeAll(async()=>{
 vi.useFakeTimers();
 document.body.innerHTML=new DOMParser().parseFromString(fs.readFileSync(process.cwd()+'/index.html','utf8'),'text/html').body.innerHTML;
 Object.defineProperty(HTMLElement.prototype,'innerText',{configurable:true,get(){return this.textContent;},set(value){this.textContent=value;}});
 HTMLElement.prototype.scrollIntoView=vi.fn();HTMLMediaElement.prototype.pause=vi.fn();HTMLMediaElement.prototype.load=vi.fn();
 HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}})},{get:(x,key)=>x[key]||(()=>{}),set:(x,key,value)=>(x[key]=value,true)});
 ({State}=await import('../src/state.js'));({History}=await import(process.cwd()+'/src/history.js'));
 Notes=await import(process.cwd()+'/src/notes.js');Settings=await import(process.cwd()+'/src/settings.js');UI=await import(process.cwd()+'/src/ui.js');Menus=await import(process.cwd()+'/src/menus.js');
 vi.stubGlobal('FileReader',class {readAsArrayBuffer(){readers.push(this);readStarted?.();}});
});
beforeEach(()=>{
 vi.advanceTimersByTime(501);document.getElementById('settingsCancelBtn')?.click();UI.closeModal();Menus.hideCtx();
 Object.assign(State,{keymap:{toggle_play_pause:[{key:' '}]},defaultKeymap:{toggle_play_pause:[{key:' '}]},notes:[{id:'note',time:1,text:'original',done:false}],cues:[],tracks:[{visible:true}],clips:[],externalAudioState:[],videoTracks:[{visible:true}],duration:10,fps:25,dropFrame:false});
 History.reset();readers=[];readStarted=null;
});
afterAll(()=>{document.getElementById('settingsCancelBtn')?.click();UI.closeModal();vi.unstubAllGlobals();vi.clearAllTimers();vi.useRealTimers();});
async function beginRead(name){
 let started;const startedPromise=new Promise(resolve=>{started=resolve;});readStarted=started;
 const work=document.getElementById('settingsImportBtn').onclick();
 const input=document.getElementById('settingsImportFile');Object.defineProperty(input,'files',{configurable:true,value:[new File(['unused'],name)]});input.dispatchEvent(new Event('change'));
 await startedPromise;return {work,reader:readers.at(-1)};
}
async function finishRead(request,key){request.reader.result=new TextEncoder().encode(JSON.stringify({keymap:{toggle_play_pause:[{key}]}})).buffer;request.reader.onload();await request.work;}
it('same settings dialog keeps latest import when readers finish in reverse order',async()=>{
 Settings.showSettingsModal();const old=await beginRead('A.json'),latest=await beginRead('B.json');
 await finishRead(latest,'b');await finishRead(old,'a');document.getElementById('settingsSaveBtn').click();
 expect(State.keymap.toggle_play_pause).toEqual([{key:'b'}]);
});
it('manual key recording invalidates a pending import of the same settings draft',async()=>{
 Settings.showSettingsModal();const old=await beginRead('A.json');key(document.getElementById('settings-input-toggle_play_pause-0'),'q');
 await finishRead(old,'a');document.getElementById('settingsSaveBtn').click();expect(State.keymap.toggle_play_pause).toEqual([{key:'q'}]);
});
it('canceling a later import invalidates the earlier read without changing the draft',async()=>{
 Settings.showSettingsModal();const old=await beginRead('A.json');const cancelled=document.getElementById('settingsImportBtn').onclick();
 document.getElementById('settingsImportFile').dispatchEvent(new Event('cancel'));await cancelled;await finishRead(old,'a');
 document.getElementById('settingsSaveBtn').click();expect(State.keymap.toggle_play_pause).toEqual([{key:' '}]);
});
it('Escape in inline note text cannot overwrite a newer committed note text',()=>{
 Notes.renderNotes();const el=document.querySelector('.nt-text');el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));el.innerText='draft';
 State.notes[0].text='background';History.record('background');key(el,'Escape');el.dispatchEvent(new FocusEvent('blur'));
 expect(State.notes[0].text).toBe('background');expect(History.committedSnapshot().notes[0].text).toBe('background');
});
it('untouched inline note blur preserves a newer committed field value',()=>{
 Notes.renderNotes();const el=document.querySelector('.nt-text');el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
 State.notes[0].text='background';History.record('background');el.dispatchEvent(new FocusEvent('blur'));
 expect(State.notes[0].text).toBe('background');
});
it('inline note time rejects a stale edit instead of overwriting a newer time',()=>{
 Notes.renderNotes();document.querySelector('.nt-time').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));const input=document.querySelector('.nt-te');input.value='00:00:02:00';
 State.notes[0].time=3;History.record('background');key(input,'Enter');expect(State.notes[0].time).toBe(3);
});
it('batch note confirmation rejects the whole stale field set atomically',()=>{
 State.notes.push({id:'second',time:2,text:'second',done:false});Notes.renderNotes();
 const rows=[...document.querySelectorAll('.note-item')];rows[0].dispatchEvent(new MouseEvent('click',{bubbles:true}));rows[1].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));rows[1].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
 [...document.querySelectorAll('.ci')].find(x=>x.textContent.includes('統一編輯文字')).click();document.getElementById('batchNoteInput').value='unified';
 State.notes[0].text='background';History.record('background');[...document.querySelectorAll('#modalFoot button')].find(x=>x.textContent==='儲存變更').click();
 expect(State.notes.map(n=>n.text)).toEqual(['background','second']);
});
it('a normal inline note edit records once and Undo/Redo restore the text',()=>{
 Notes.renderNotes();const el=document.querySelector('.nt-text');el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));el.innerText='edited';el.dispatchEvent(new FocusEvent('blur'));
 expect(State.notes[0].text).toBe('edited');expect(History.stack).toHaveLength(2);History.undo();expect(State.notes[0].text).toBe('original');History.redo();expect(State.notes[0].text).toBe('edited');
});
it('a normal inline note time edit records once and Undo restores the time',()=>{
 Notes.renderNotes();document.querySelector('.nt-time').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));const input=document.querySelector('.nt-te');input.value='00:00:02:12';key(input,'Enter');
 expect(State.notes[0].time).toBe(2.48);expect(History.stack).toHaveLength(2);History.undo();expect(State.notes[0].time).toBe(1);
});
it('note Escape and untouched blur record no Undo step',()=>{
 Notes.renderNotes();let el=document.querySelector('.nt-text');el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));el.innerText='discard';key(el,'Escape');
 el=document.querySelector('.nt-text');el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));el.dispatchEvent(new FocusEvent('blur'));
 expect(State.notes[0].text).toBe('original');expect(History.stack).toHaveLength(1);
});
it('History reset invalidates an open note edit even with the same note objects',()=>{
 Notes.renderNotes();const el=document.querySelector('.nt-text');el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));el.innerText='old draft';History.reset();el.dispatchEvent(new FocusEvent('blur'));
 expect(State.notes[0].text).toBe('original');expect(History.stack).toHaveLength(1);
});
it('a changed FPS grid invalidates the note time editor',async()=>{
 Notes.renderNotes();document.querySelector('.nt-time').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));const input=document.querySelector('.nt-te');input.value='00:00:02:12';
 const {setFps}=await import('../src/state.js');setFps('29.97df');key(input,'Enter');expect(State.notes[0].time).toBe(1);expect(History.stack).toHaveLength(1);
});
it('restoring defaults invalidates a pending shortcut import',async()=>{
 Settings.showSettingsModal();const old=await beginRead('A.json');document.getElementById('settingsRestoreBtn').click();await finishRead(old,'a');document.getElementById('settingsSaveBtn').click();expect(State.keymap.toggle_play_pause).toEqual([{key:' '}]);
});
it('latest shortcut import still installs valid normalized keys',async()=>{
 Settings.showSettingsModal();const request=await beginRead('normal.json');await finishRead(request,'Q');document.getElementById('settingsSaveBtn').click();expect(State.keymap.toggle_play_pause).toEqual([{key:'q'}]);
});

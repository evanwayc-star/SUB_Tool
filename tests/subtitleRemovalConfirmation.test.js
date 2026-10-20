// @vitest-environment jsdom
import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
let State,SM,History,Subtitles,Model,UI,Menus,Project,Timeline,Subio;
const click=label=>[...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent===label)?.click();
const primary=()=>document.querySelector('#modalFoot button.primary')?.click();
const visible=()=>document.getElementById('modalBg').classList.contains('show');
beforeAll(async()=>{
 vi.useFakeTimers();document.body.innerHTML=new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'),'utf8'),'text/html').body.innerHTML;
 Object.defineProperty(HTMLElement.prototype,'innerText',{configurable:true,get(){return this.textContent;},set(v){this.textContent=v;}});
 Object.defineProperty(HTMLElement.prototype,'isContentEditable',{configurable:true,get(){return this.getAttribute('contenteditable')==='true';}});
 HTMLElement.prototype.scrollIntoView=vi.fn();HTMLMediaElement.prototype.pause=vi.fn();HTMLMediaElement.prototype.load=vi.fn();
 HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:1}),createLinearGradient:()=>({addColorStop(){}})},{get:(t,k)=>t[k]||(()=>{})});
 SM=await import('../src/state.js');({State}=SM);({History}=await import('../src/history.js'));Model=await import('../src/subtitle-model.js');Subtitles=await import('../src/subtitles.js');UI=await import('../src/ui.js');Menus=await import('../src/menus.js');({Project}=await import('../src/project.js'));Timeline=await import('../src/timeline-renderer.js');Subio=await import('../src/subio.js');await import('../src/keyboard.js');
 const {on}=await import('../src/events.js');on('history:record',label=>History.record(label));
 const {ensureProjectSaved}=await import('../src/project.js');const guard=ensureProjectSaved();click('稍後再說');await guard;
});
beforeEach(()=>{
 UI.closeModal();Menus.hideCtx();window.dispatchEvent(new Event('blur'));document.getElementById('subStyleFilter').value='';
 Object.assign(State,{cues:[{id:'a',start:1,end:2,text:'甲',track:0},{id:'b',start:3,end:4,text:'乙',track:0}],tracks:[{name:'對白',visible:true,locked:false}],trackCount:1,listTrack:0,clips:[],notes:[],externalAudioState:[],externalAudioEnd:0,videoTracks:[{name:'V1',visible:true,locked:false}],audioProject:{buses:[],sourceMaps:{},exportLayout:{streams:[]}},fps:25,dropFrame:false,duration:10,subMode:false,overwriteMode:false,overwriteKeep:true,presetEdit:null});
 SM.setSelection({kind:'sub',ids:['a'],primary:'a'});History.reset();Subtitles.renderSubList();
});
afterAll(()=>{UI.closeModal();vi.clearAllTimers();vi.useRealTimers();});
it.each(['toolbar','keyboard'])('單句 %s 刪除先明示1句；取消不改內容或Undo，確認才移除',async entry=>{
 const original=structuredClone(State.cues);const invoke=()=>entry==='toolbar'?Subtitles.deleteSelected():document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));
 invoke();expect(State.cues).toEqual(original);expect(visible()).toBe(true);expect(document.getElementById('modalBody').textContent).toMatch(/1/);expect(History.stack).toHaveLength(1);
 click('取消');expect(State.cues).toEqual(original);expect(History.stack).toHaveLength(1);invoke();primary();await Promise.resolve();expect(State.cues.map(c=>c.id)).toEqual(['b']);expect(History.stack).toHaveLength(2);History.undo();expect(State.cues).toEqual(original);
});
it.each(['text','time','replace-same-id','lock'])('刪除確認在 %s 變更後過期，不能移除新內容',async change=>{
 Subtitles.deleteSelected();expect(State.cues).toHaveLength(2);expect(visible()).toBe(true);
 if(change==='text')State.cues[0].text='較新提交';if(change==='time')State.cues[0].end=2.5;if(change==='replace-same-id')State.cues[0]={...State.cues[0]};if(change==='lock')State.tracks[0].locked=true;
 const before=structuredClone(State.cues);primary();await Promise.resolve();expect(State.cues).toEqual(before);expect(History.stack).toHaveLength(1);
});
it('真正右鍵合併先確認移除1句，取消不改文字與時間，確認只記一次',async()=>{
 Menus.showCueMenu(10,10);const merge=[...document.querySelectorAll('#ctxmenu .ci')].find(el=>el.textContent.includes('與下句合併'));expect(merge).toBeTruthy();merge.click();expect(State.cues).toHaveLength(2);expect(State.cues[0].text).toBe('甲');expect(visible()).toBe(true);click('取消');expect(History.stack).toHaveLength(1);
 Menus.showCueMenu(10,10);[...document.querySelectorAll('#ctxmenu .ci')].find(el=>el.textContent.includes('與下句合併')).click();primary();expect(State.cues).toHaveLength(1);expect(State.cues[0].text).toBe('甲 乙');expect(History.stack).toHaveLength(2);
});
it('匯入覆蓋已有軌道先確認舊2句；取消不改任何既有資料',async()=>{
 Subio._openImportModal('匯入字幕',[{start:5,end:6,text:'新稿'}],'srt');await vi.advanceTimersByTimeAsync(35);document.getElementById('importTkSel').value='0';document.getElementById('importAppend').checked=false;const before=History.snap();primary();expect(State.cues.map(c=>c.text)).toEqual(['甲','乙']);expect(visible()).toBe(true);expect(document.getElementById('modalBody').textContent).toMatch(/2/);click('取消');expect(History.snap()).toEqual(before);expect(History.stack).toHaveLength(1);
});
it('刪軌確認後同物件字幕被改寫，舊確認不得刪軌',()=>{
 Timeline.removeTrack(0);expect(visible()).toBe(true);State.cues[0].text='新修訂';primary();expect(State.cues).toHaveLength(2);expect(State.tracks).toHaveLength(1);expect(History.stack).toHaveLength(1);
});
it('已保存且有字幕的專案換檔直接呼叫reader，不顯示移除字幕提示',async()=>{
 Project.establishCleanBaseline();const read=vi.fn(async()=>null);await expect(Project.open(read)).resolves.toBe(false);expect(visible()).toBe(false);expect(read).toHaveBeenCalledOnce();expect(State.cues).toHaveLength(2);
});

it.each(['in','out'])('真正 %s 點完整覆蓋先確認，取消連原字幕時間也不改；確認一筆Undo',async edge=>{
 const {Media}=await import('../src/media.js');const Transport=await import('../src/transport-controller.js');
 State.overwriteMode=true;State.overwriteKeep=false;if(edge==='in'){State.cues[0].start=5;State.cues[0].end=6;}
 History.reset();const before=structuredClone(State.cues),clock=vi.spyOn(Media,'displayTime').mockReturnValue(edge==='in'?1:5);
 try{
  await (edge==='in'?Transport.setIn():Transport.setOut());expect(State.cues).toEqual(before);expect(visible()).toBe(true);expect(document.getElementById('modalBody').textContent).toMatch(/1/);click('取消');expect(State.cues).toEqual(before);expect(History.stack).toHaveLength(1);
  await (edge==='in'?Transport.setIn():Transport.setOut());primary();expect(State.cues.map(c=>c.id)).toEqual(['a']);expect(History.stack).toHaveLength(2);History.undo();expect(State.cues).toEqual(before);
 }finally{clock.mockRestore();}
});
it('真正列表時間欄的覆蓋取消不改時間，確認才刪除被完整覆蓋的句子',async()=>{
 State.overwriteMode=true;State.overwriteKeep=false;History.reset();const before=structuredClone(State.cues);
 const edit=async()=>{Subtitles.renderSubList();document.querySelector('.sub-row[data-id="a"] .tout').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));await Promise.resolve();const input=document.querySelector('.tc-edit');expect(input).toBeTruthy();input.value='00:00:05:00';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));};
 await edit();expect(State.cues).toEqual(before);expect(visible()).toBe(true);click('取消');expect(History.stack).toHaveLength(1);await edit();primary();expect(State.cues).toHaveLength(1);expect(State.cues[0].end).toBe(5);expect(History.stack).toHaveLength(2);
});
it.each([false,true])('真正時間軸覆蓋拖曳先撤回預覽再確認（複製=%s），取消原稿與Undo不變',async copying=>{
 State.cues[0].end=3;State.cues[1].start=5;State.cues[1].end=6;State.overwriteMode=true;State.overwriteKeep=false;State.snapOn=false;State.pxPerSec=80;State.viewStart=0;State.vtracksCollapsed=false;
 const layer=document.getElementById('tlLayer'),scroll=document.getElementById('tlScroll');for(const el of [layer,scroll]){el.getBoundingClientRect=()=>({left:0,top:0,right:800,bottom:500,width:800,height:500});Object.defineProperty(el,'clientWidth',{configurable:true,value:800});Object.defineProperty(el,'clientHeight',{configurable:true,value:500});}
 Timeline.drawTimeline();History.reset();const before=structuredClone(State.cues);const y=Timeline.tracksTop()+10;
 const gesture=()=>{const block=document.querySelector('.cue-block[data-id="a"]');block.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,clientX:90,clientY:y,altKey:copying}));window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:410,clientY:y,altKey:copying}));window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:410,clientY:y,altKey:copying}));};
 gesture();expect(State.cues).toEqual(before);expect(visible()).toBe(true);expect(History.stack).toHaveLength(1);click('取消');expect(State.cues).toEqual(before);gesture();primary();expect(State.cues.some(c=>c.id==='b')).toBe(false);expect(History.stack).toHaveLength(2);History.undo();expect(State.cues).toEqual(before);
});

it('多句刪除只顯示一次具體句數，取消零變更，確認可一次Undo',()=>{
 SM.setSelection({kind:'sub',ids:['a','b'],primary:'a'});const before=structuredClone(State.cues);Subtitles.deleteSelected();expect(State.cues).toEqual(before);expect(document.getElementById('modalBody').textContent).toMatch(/2/);click('取消');expect(History.stack).toHaveLength(1);Subtitles.deleteSelected();primary();expect(State.cues).toHaveLength(0);expect(visible()).toBe(false);expect(History.stack).toHaveLength(2);History.undo();expect(State.cues).toEqual(before);
});
it.each(['merge','import','track','new-project'])('%s 確認期間同物件改字後不得移除既有字幕',async action=>{
 if(action==='merge'){Menus.showCueMenu(1,1);[...document.querySelectorAll('#ctxmenu .ci')].find(el=>el.textContent.includes('與下句合併')).click();}
 else if(action==='import'){Subio._openImportModal('匯入字幕',[{start:5,end:6,text:'新稿'}],'srt');await vi.advanceTimersByTimeAsync(35);document.getElementById('importTkSel').value='0';primary();}
 else if(action==='track') Timeline.removeTrack(0);
 else {const {startNewProject}=await import('../src/project.js');startNewProject();}
 expect(visible()).toBe(true);State.cues[0].text='確認期間的新稿';const before=structuredClone(State.cues);primary();await Promise.resolve();expect(State.cues).toEqual(before);expect(History.stack).toHaveLength(1);
});
it('附加與新增軌的匯入不移除既有字幕，無額外移除確認',async()=>{
 Subio._openImportModal('匯入字幕',[{start:5,end:6,text:'附加'}],'srt');await vi.advanceTimersByTimeAsync(35);document.getElementById('importTkSel').value='0';document.getElementById('importAppend').checked=true;primary();expect(State.cues.map(c=>c.text)).toEqual(['甲','乙','附加']);expect(visible()).toBe(false);expect(History.stack).toHaveLength(2);
});
it('讀檔等待期間新增並儲存的字幕不再觸發移除警告',async()=>{
 Project.establishCleanBaseline();let finishRead;const read=vi.fn(()=>new Promise(resolve=>{finishRead=resolve;}));const pending=Project.open(read);await Promise.resolve();await Promise.resolve();expect(read).toHaveBeenCalledOnce();
 State.cues.push({id:'later',start:7,end:8,text:'已儲存的新句',track:0});History.record('新增');Project.establishCleanBaseline();
 const load=vi.spyOn(Project,'load').mockResolvedValueOnce(true);
 try{const file=new File(['{}'],'new.subtool');finishRead(file);await expect(pending).resolves.toBe(true);expect(load).toHaveBeenCalledWith(file);expect(visible()).toBe(false);}finally{load.mockRestore();}
});
it('覆蓋計畫與model共用規則，預查不分配ID或改資料，部分裁切不要求整句移除確認',()=>{
 State.overwriteMode=true;State.overwriteKeep=false;const before=structuredClone(State.cues);expect(Model.planContainedCueRemovals([{...State.cues[0],end:3.5}])).toEqual([]);expect(State.cues).toEqual(before);expect(Model.planContainedCueRemovals([{...State.cues[0],end:5}])).toEqual([State.cues[1]]);expect(State.cues).toEqual(before);expect(History.stack).toHaveLength(1);
});

it.each(['取消','確定刪除'])('刪除確認的 Enter 尊重焦點「%s」，不搶先執行另一顆按鈕',label=>{
 const before=structuredClone(State.cues);Subtitles.deleteSelected();
 const button=[...document.querySelectorAll('#modalFoot button')].find(item=>item.textContent===label);
 button.focus();expect(document.activeElement).toBe(button);
 const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});button.dispatchEvent(event);
 expect(event.defaultPrevented).toBe(false);expect(State.cues).toEqual(before);expect(History.stack).toHaveLength(1);
 // jsdom does not perform the browser's native Enter activation of a button.
 button.click();expect(visible()).toBe(false);
 expect(State.cues).toEqual(label==='取消'?before:[before[1]]);
 expect(History.stack).toHaveLength(label==='取消'?1:2);
 if(label!=='取消'){History.undo();expect(State.cues).toEqual(before);}
});

it('對話框不儲存按鈕及其內層文字的 Enter 不改走主要儲存動作',()=>{
 const save=vi.fn(),discard=vi.fn();let session;
 session=UI.openModal('未儲存變更','<p>選擇後續動作</p>',[
  {label:'儲存',primary:true,act:save},{label:'不儲存',act:()=>{discard();session.close({committed:true});}},
 ]);
 const button=document.querySelector('#modalFoot button:last-child');button.innerHTML='<span>不儲存</span>';button.focus();
 const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});button.firstChild.dispatchEvent(event);
 expect(event.defaultPrevented).toBe(false);expect(save).not.toHaveBeenCalled();expect(discard).not.toHaveBeenCalled();
 button.click();expect(discard).toHaveBeenCalledOnce();expect(save).not.toHaveBeenCalled();expect(visible()).toBe(false);
});

it.each(['text','number'])('單行 %s 欄位的 Enter 保留主要確認，關窗後不外洩快捷鍵',type=>{
 const confirm=vi.fn(),outer=vi.fn();let session;
 session=UI.openModal('確認輸入',`<input id="modalKeyboardInput" type="${type}">`,[
  {label:'確認',primary:true,act:()=>{confirm();session.close({committed:true});}},
 ]);
 window.addEventListener('keydown',outer);
 try{
  const input=document.getElementById('modalKeyboardInput');input.focus();
  const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);expect(confirm).toHaveBeenCalledOnce();expect(outer).not.toHaveBeenCalled();expect(visible()).toBe(false);
 }finally{window.removeEventListener('keydown',outer);}
});

it.each([
 '<select><option>第一項</option></select>', '<a href="#modal-target">說明</a>', '<details><summary>選項</summary></details>',
 ...['button','submit','reset','checkbox','radio','range','file','color'].map(type=>`<input type="${type}">`),
 '<input type="text" disabled>', '<button disabled>停用</button>',
])('原生控制項 Enter 保留自身行為，不觸發主要確認：%s',html=>{
 const confirm=vi.fn(),outer=vi.fn();UI.openModal('原生控制項',html,[{label:'確認',primary:true,act:confirm}]);
 const control=document.querySelector('#modalBody summary, #modalBody input, #modalBody select, #modalBody a, #modalBody button');
 window.addEventListener('keydown',outer);
 try{
  const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});control.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);expect(confirm).not.toHaveBeenCalled();expect(outer).not.toHaveBeenCalled();expect(visible()).toBe(true);
 }finally{window.removeEventListener('keydown',outer);}
});

it('多行欄位、組字 Enter、停用確認與 Escape 保留各自對話框語意',()=>{
 const confirm=vi.fn();UI.openModal('輸入','<textarea></textarea><div contenteditable="true">文字</div><input>',[
  {label:'確認',primary:true,act:confirm},
 ]);
 for(const control of document.querySelectorAll('#modalBody textarea, #modalBody [contenteditable]')){
  const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});control.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);expect(confirm).not.toHaveBeenCalled();
 }
 const input=document.querySelector('#modalBody input');
 for(const options of [{isComposing:true},{keyCode:229}]){
  const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options});input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);expect(confirm).not.toHaveBeenCalled();expect(visible()).toBe(true);
 }
 document.querySelector('#modalFoot button.primary').disabled=true;
 input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));expect(confirm).not.toHaveBeenCalled();
 input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));expect(confirm).not.toHaveBeenCalled();expect(visible()).toBe(false);
});

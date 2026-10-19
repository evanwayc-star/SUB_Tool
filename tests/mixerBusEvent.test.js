// @vitest-environment jsdom
/* 專案音訊 bus（A1…An）的 M／S／音量變更如何通知下游。
   來由與事件表見 docs/技術架構說明.md §5——那裡是唯一的完整說明，這裡只鎖行為。

   本檔【真的 import mixer.js 並點真實的 DOM 按鈕】，不是比對原始碼字串。
   上一版全部用 toMatch 掃原始碼，於是「測試全綠」只證明了字面沒被改掉，
   notifyBusChange 一次都沒被執行到——正是技術架構說明 §0.6
   「有產出不等於對」講的那種測了等於沒測。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* media.js 有 2800 行且與 mixer.js 互為 import，測試裡換成替身。
   它的訂閱端無法在這裡行為驗證，改以最後一節的原始碼契約 + 真機驗證涵蓋。 */
const mediaMock = vi.hoisted(() => ({
  applyGains: vi.fn(),
  activeSource: null,
  displayTime:()=>0,
  externalAudio:{list:()=>[],get:()=>null},
  getSources: () => [],
  tracks: [],
  panel: {},
  audioPanelState(){return this.panel;},
}));
vi.mock('../src/media.js', () => ({ Media: mediaMock, Wave: {} }));
vi.mock('../src/timeline-renderer.js', () => ({ drawTimeline: vi.fn(), drawRuler: vi.fn() }));

let on, State, renderAudioTracks, renderMixer, mixerMuteAll;
let seen;
afterEach(()=>vi.restoreAllMocks());

beforeEach(async () => {
  vi.resetModules();
  mediaMock.applyGains.mockClear();
  mediaMock.panel={};
  document.body.innerHTML =
    '<style>'+fs.readFileSync(path.join(process.cwd(),'src/styles.css'),'utf8')+'</style><div id="ctxmenu"></div><div id="toast"></div>'+
    '<div id="modalBg"><div class="modal"><div id="modalTitle"></div><div id="modalBody"></div><div id="modalFoot"></div></div></div><span id="atHint" hidden></span><div id="atList"></div>' +
    '<div id="mixerPanel" class="show"><div id="mixerStrips"></div></div>';

  ({ on } = await import('../src/events.js'));
  ({ State } = await import('../src/state.js'));
  ({ renderAudioTracks, renderMixer, mixerMuteAll } = await import('../src/mixer.js'));

  State.audioProject = {
    buses: [{ id: 'ab1', name: 'A1', muted: false, solo: false, volume: 1 }],
    sourceMaps: {},
  };
  seen = [];
  on('audio:busChanged', d => seen.push(d));
});

describe('混音器 UI → audio:busChanged', () => {
  it('滾輪音量透過共用提交入口建立可復原的動作', async () => {
    const { History } = await import('../src/history.js');
    on('history:record', label => History.record(label));
      History.reset();
      renderMixer();
      document.querySelector('#mixerStrips .mx-fader-val').dispatchEvent(new WheelEvent('wheel', { deltaY: -1, cancelable: true }));
      const volume = State.audioProject.buses[0].volume;
      expect(volume).toBeGreaterThan(1);
      History.undo();
      expect(State.audioProject.buses[0].volume).toBe(1);
      History.redo();
      expect(State.audioProject.buses[0].volume).toBe(volume);
  });

  it('點靜音鈕會翻轉狀態並發出事件（帶 busId / field / value）', () => {
    renderMixer();
    document.querySelector('#mixerStrips .mx-mute').click();

    expect(State.audioProject.buses[0].muted).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ busId: 'ab1', field: 'muted', value: true });
  });

  it('點獨奏鈕同樣發出事件', () => {
    renderMixer();
    document.querySelector('#mixerStrips .mx-solo').click();

    expect(State.audioProject.buses[0].solo).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ field: 'solo', value: true });
  });

  /* 音軌列（時間軸左側列頭）是第二個入口，與混音器面板共用 notifyBusChange。
     兩個入口都要測——只測一個的話，另一個被改壞不會有人發現。 */
  it('音軌列的靜音鈕走同一條路', () => {
    renderAudioTracks();
    document.querySelector('#atList .mute').click();

    expect(State.audioProject.buses[0].muted).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('全部靜音也發出事件', () => {
    mixerMuteAll();

    expect(State.audioProject.buses[0].muted).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ field: 'muteAll' });
  });
});

/* 拖曳推桿期間刻意【不】發事件：每次 input 都重繪整條時間軸太貴，只即時套增益，
   放開（change）才發事件做完整重繪。日後若有人「順手統一」成一律發事件，
   畫面不會壞、只會變卡——這種退步沒有測試就抓不到。 */
describe('拖曳音量推桿的快路徑', () => {
  it('拖曳中（input）只套增益，不發事件', () => {
    renderMixer();
    const fader = document.querySelector('#mixerStrips .mx-fader');
    fader.value = '40';
    fader.dispatchEvent(new Event('input'));

    expect(mediaMock.applyGains).toHaveBeenCalled();
    expect(State.audioProject.buses[0].volume).toBeCloseTo(0.4);
    expect(seen).toHaveLength(0);
  });

  it('放開（change）才發事件', () => {
    renderMixer();
    const fader = document.querySelector('#mixerStrips .mx-fader');
    fader.value = '40';
    fader.dispatchEvent(new Event('input'));
    fader.dispatchEvent(new Event('change'));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ field: 'volume' });
  });

  it('音量沒有實際變動時不發事件（避免空重繪）', () => {
    renderMixer();
    document.querySelector('#mixerStrips .mx-fader').dispatchEvent(new Event('change'));

    expect(seen).toHaveLength(0);
  });
});

describe('bus 音量編輯的欄位與持久化 owner',()=>{
  async function startHistory(){
    const {History}=await import('../src/history.js');
    on('history:record',label=>History.record(label));History.reset();return History;
  }
  it.each(['.mx-fader','#atList input[type=range]'])('%s 預覽不混入其他提交，放開仍只有一筆獨立 Undo',async selector=>{
    const History=await startHistory();renderAudioTracks();const fader=document.querySelector(selector);
    fader.value='40';fader.dispatchEvent(new Event('input'));
    State.cues.push({id:'background',start:1,end:2,text:'new cue',track:0});State.audioProject.buses[0].muted=true;History.record('background');
    expect(State.audioProject.buses[0].volume).toBe(.4);
    expect(History.stack.at(-1).snap.audioProject.buses[0]).toMatchObject({volume:1,muted:true});
    fader.dispatchEvent(new Event('change'));expect(History.stack).toHaveLength(3);
    History.undo();expect(State.audioProject.buses[0]).toMatchObject({volume:1,muted:true});expect(State.cues).toHaveLength(1);
    History.redo();expect(State.audioProject.buses[0].volume).toBe(.4);
  });
  it.each(['Escape','blur','redraw'])('%s 取消只還原自己的volume，保留其他bus欄位',async action=>{
    const History=await startHistory();renderMixer();const fader=document.querySelector('.mx-fader');
    fader.value='40';fader.dispatchEvent(new Event('input'));State.audioProject.buses[0].name='background name';History.record('name');
    if(action==='Escape') fader.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}));
    else if(action==='blur') window.dispatchEvent(new Event('blur'));
    else renderMixer();
    expect(State.audioProject.buses[0]).toMatchObject({volume:1,name:'background name'});expect(History.stack).toHaveLength(2);
    expect(History.committedSnapshot().audioProject.buses[0]).toMatchObject({volume:1,name:'background name'});
  });
  it.each(['field','reset','replacement','detached'])('晚到 inline blur 在 %s 後無修改資格',async reason=>{
    const History=await startHistory();renderMixer();document.querySelector('.mx-fader-val').click();
    const input=document.querySelector('.mx-fader-inline-input');input.value='-6';
    if(reason==='field'){State.audioProject.buses[0].volume=.75;History.record('background volume');}
    if(reason==='reset') History.reset();
    if(reason==='replacement') State.audioProject.buses=[{...State.audioProject.buses[0],volume:.75}];
    if(reason==='detached') input.remove();
    const before=structuredClone(State.audioProject),steps=History.stack.length;input.dispatchEvent(new FocusEvent('blur'));
    expect(State.audioProject).toEqual(before);expect(History.stack).toHaveLength(steps);
  });
  it.each([{key:'Enter',isComposing:true},{key:'Escape',isComposing:true},{key:'Enter',keyCode:229}])('dB 組字 %j 不提早提交或取消，一般 Enter 仍能確認',async options=>{
    const History=await startHistory();renderMixer();document.querySelector('.mx-fader-val').click();
    const input=document.querySelector('.mx-fader-inline-input');input.value='-6';
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,...options});input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);expect(input.isConnected).toBe(true);
    expect(State.audioProject.buses[0].volume).toBe(1);expect(History.stack).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    expect(input.isConnected).toBe(false);expect(State.audioProject.buses[0].volume).toBeCloseTo(10**(-6/20));
    expect(History.stack).toHaveLength(2);
  });
  it('正常 inline 提交一次，Escape 與原值提交皆無空步驟',async()=>{
    const History=await startHistory();renderMixer();document.querySelector('.mx-fader-val').click();
    let input=document.querySelector('.mx-fader-inline-input');input.value='-6';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));
    const volume=State.audioProject.buses[0].volume;expect(volume).toBeCloseTo(.5012);expect(History.stack).toHaveLength(2);
    History.undo();expect(State.audioProject.buses[0].volume).toBe(1);History.redo();expect(State.audioProject.buses[0].volume).toBe(volume);
    renderMixer();document.querySelector('.mx-fader-val').click();input=document.querySelector('.mx-fader-inline-input');
    input.value='-10';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));input.dispatchEvent(new FocusEvent('blur'));
    expect(State.audioProject.buses[0].volume).toBe(volume);expect(History.stack).toHaveLength(2);
    renderMixer();document.querySelector('.mx-fader-val').click();input=document.querySelector('.mx-fader-inline-input');
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));expect(History.stack).toHaveLength(2);
  });
  it('未改動四捨五入的dB讀數不重算精確gain或建立History，Escape顯示目前欄位',async()=>{
    State.audioProject.buses[0].volume=.75;const History=await startHistory();renderMixer();document.querySelector('.mx-fader-val').click();
    let input=document.querySelector('.mx-fader-inline-input');expect(input.value).toBe('-2.5');input.dispatchEvent(new FocusEvent('blur'));
    expect(State.audioProject.buses[0].volume).toBe(.75);expect(History.stack).toHaveLength(1);
    document.querySelector('.mx-fader-val').click();input=document.querySelector('.mx-fader-inline-input');input.value='-10';
    State.audioProject.buses[0].volume=.5;History.record('background');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
    expect(document.querySelector('.mx-fader-val').textContent).toBe('-6.0 dB');expect(State.audioProject.buses[0].volume).toBe(.5);
  });
  it('atList dblclick 使用HTML對話框，未改值保持gain，確認與取消保留一次提交契約',async()=>{
    const nativePrompt=vi.spyOn(window,'prompt').mockImplementation(()=>{throw new Error('Electron prompt unavailable');});
    State.audioProject.buses[0].volume=.75;const History=await startHistory();renderAudioTracks();
    const open=()=>document.querySelector('#atList input').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    const click=label=>[...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent===label).click();
    open();expect(document.getElementById('__promptInput')).toBeTruthy();click('確定');await Promise.resolve();
    expect(State.audioProject.buses[0].volume).toBe(.75);expect(History.stack).toHaveLength(1);
    open();document.getElementById('__promptInput').value='-6';click('確定');await Promise.resolve();
    expect(State.audioProject.buses[0].volume).toBeCloseTo(.5012);expect(History.stack).toHaveLength(2);
    open();document.getElementById('__promptInput').value='-12';click('取消');await Promise.resolve();
    expect(State.audioProject.buses[0].volume).toBeCloseTo(.5012);expect(History.stack).toHaveLength(2);expect(nativePrompt).not.toHaveBeenCalled();
  });
  it.each(['field','reset','replacement','modal-replacement'])('atList 音量對話框在 %s 後拒絕舊確認',async reason=>{
    const History=await startHistory();renderAudioTracks();document.querySelector('#atList input').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    document.getElementById('__promptInput').value='-6';const confirm=document.querySelector('#modalFoot button.primary');
    if(reason==='field'){State.audioProject.buses[0].volume=.75;History.record('background');}
    if(reason==='reset') History.reset();
    if(reason==='replacement') State.audioProject.buses=[{...State.audioProject.buses[0],volume:.75}];
    if(reason==='modal-replacement'){const {openModal}=await import('../src/ui.js');openModal('new modal','<p>keep</p>');}
    const before=structuredClone(State.audioProject),steps=History.stack.length;confirm.click();await Promise.resolve();
    expect(State.audioProject).toEqual(before);expect(History.stack).toHaveLength(steps);
    if(reason==='modal-replacement') expect(document.getElementById('modalTitle').textContent).toBe('new modal');
  });
  it('全軌dB同樣使用HTML對話框並以同一個Undo提交，等待期間新音軌撤銷旧scope',async()=>{
    const nativePrompt=vi.spyOn(window,'prompt').mockImplementation(()=>{throw new Error('Electron prompt unavailable');});
    State.audioProject.buses.push({id:'ab2',name:'A2',volume:.5,muted:false,solo:false});const History=await startHistory();
    const {mixerAdjustAllDb}=await import('../src/mixer.js');let work=mixerAdjustAllDb();document.getElementById('__promptInput').value='+2';
    document.querySelector('#modalFoot button.primary').click();await work;expect(History.stack).toHaveLength(2);
    expect(State.audioProject.buses.map(bus=>bus.volume)).toEqual([1.2589,.6295]);History.undo();expect(State.audioProject.buses.map(bus=>bus.volume)).toEqual([1,.5]);
    work=mixerAdjustAllDb();document.getElementById('__promptInput').value='+2';State.audioProject.buses=[...State.audioProject.buses,{id:'ab3',name:'A3',volume:1}];
    const before=structuredClone(State.audioProject),steps=History.stack.length;document.querySelector('#modalFoot button.primary').click();await work;
    expect(State.audioProject).toEqual(before);expect(History.stack).toHaveLength(steps);expect(nativePrompt).not.toHaveBeenCalled();
  });
  it('專案實際儲存位元組排除volume草稿，保留背景bus欄位',async()=>{
    const History=await startHistory();State.clips=[];State.cues=[];State.notes=[];
    renderMixer();const fader=document.querySelector('.mx-fader');fader.value='40';fader.dispatchEvent(new Event('input'));
    State.audioProject.buses[0].name='background name';History.record('name');
    let blob;Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(value=>{blob=value;return 'blob:save';})});
    Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
    const {Project}=await import('../src/project.js');expect(await Project.save()).toBeTruthy();
    const bytes=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsArrayBuffer(blob);});
    const saved=JSON.parse(new TextDecoder('utf-16le').decode(bytes));expect(saved.audioProject.buses[0]).toMatchObject({volume:1,name:'background name'});
  });
});

describe('音訊面板提示的單一 DOM owner',()=>{
  it('可抽取多音軌時 computed style 可見，重繪後仍可執行當前動作',()=>{
    const run=vi.fn();mediaMock.panel={extraction:{count:2,run}};renderAudioTracks();
    const hint=document.getElementById('atHint'),old=document.getElementById('extractLink');
    expect(getComputedStyle(hint).display).not.toBe('none');expect(hint.textContent).toContain('2 條音軌');
    renderAudioTracks();expect(getComputedStyle(hint).display).not.toBe('none');
    old.click();expect(run).not.toHaveBeenCalled();document.getElementById('extractLink').click();expect(run).toHaveBeenCalledOnce();
    mediaMock.panel={};renderAudioTracks();expect(getComputedStyle(hint).display).toBe('none');expect(document.getElementById('extractLink')).toBeNull();
  });
  it('能力限制訊息與抽取連結可共同顯示，沒有HTML插入',()=>{
    const run=vi.fn();mediaMock.panel={notice:'<b>限制</b>',extraction:{count:2,run}};renderAudioTracks();
    const hint=document.getElementById('atHint');expect(getComputedStyle(hint).display).not.toBe('none');
    expect(hint.textContent).toContain('<b>限制</b>');expect(hint.querySelector('b')).toBeNull();
    mediaMock.panel={notice:'保留限制'};renderAudioTracks();expect(hint.textContent).toBe('保留限制');expect(document.getElementById('extractLink')).toBeNull();
  });
});

describe('音訊軌初始化與呈現的所有權',()=>{
  it('沒有來源聲道的圖片專案重繪不會建立音訊軌或改寫專案',()=>{
    State.clips=[{id:'image-only',type:'image',in:0,out:5,offset:0,dur:5}];
    State.audioProject={mode:'auto',buses:[],sourceMaps:{},exportLayout:{streams:[]}};
    const initial=structuredClone(State.audioProject);
    renderAudioTracks();renderMixer();
    expect(State.audioProject).toEqual(initial);
    expect(document.querySelectorAll('#atList .project-bus')).toHaveLength(0);
    expect(document.querySelectorAll('#mixerStrips .project-bus')).toHaveLength(0);
  });

  it('來源註冊建立音軌；配線清為零的預覽、取消、提交與 Undo/Redo 不被真實 mixer 重建',async()=>{
    const {resetAudioProject,ensureAudioSourceMap}=await import('../src/state.js');
    const {History}=await import('../src/history.js');
    const {AudioRouting}=await import('../src/audio-routing.js');
    const {closeModal}=await import('../src/ui.js');
    State.clips=[{id:'primary',primary:true,audioSourceId:'mother',audioSrc:'video',path:'C:/mother.mov',in:0,out:5,offset:0,dur:5}];
    resetAudioProject();
    ensureAudioSourceMap('mother',[{sourceStream:0,sourceChannel:0},{sourceStream:0,sourceChannel:1}]);
    const initial=structuredClone(State.audioProject);
    expect(initial.buses).toHaveLength(2);
    renderAudioTracks();expect(document.querySelectorAll('#atList .project-bus')).toHaveLength(2);
    on('history:record',label=>History.record(label));History.reset();
    const zero=async()=>{
      AudioRouting.openOutputSettings();
      await new Promise(resolve=>setTimeout(resolve,0));
      document.getElementById('audioOutputBusCount').value='0';
      document.getElementById('audioOutputBusApply').click();
      expect(document.getElementById('audioOutputBusCount').value).toBe('0');
      expect(State.audioProject.buses).toHaveLength(0);
      expect(document.querySelectorAll('#atList .project-bus')).toHaveLength(0);
      expect(document.querySelectorAll('#mixerStrips .project-bus')).toHaveLength(0);
    };
    await zero();
    expect(History.committedSnapshot().audioProject).toEqual(initial);
    closeModal();expect(State.audioProject).toEqual(initial);
    await zero();
    document.querySelector('#modalFoot button.primary').click();
    expect(History.stack).toHaveLength(2);
    expect(History.committedSnapshot().audioProject.buses).toHaveLength(0);
    renderAudioTracks();renderMixer();expect(State.audioProject.buses).toHaveLength(0);
    History.undo();expect(State.audioProject).toEqual(initial);
    History.redo();renderAudioTracks();renderMixer();
    expect(State.audioProject.buses).toHaveLength(0);
  });
});

describe('回歸防護', () => {
  /* 舊路徑必須真的不再有人發；在 jsdom 裡可直接行為驗證，不必比對原始碼。 */
  it('不再繞道 window CustomEvent', () => {
    const spy = vi.fn();
    window.addEventListener('audio-project:bus-change', spy);

    renderMixer();
    document.querySelector('#mixerStrips .mx-mute').click();

    expect(spy).not.toHaveBeenCalled();
  });

  it('沒有訂閱者時 emit 是靜默 no-op（這正是死事件當初沒被發現的原因）', async () => {
    const { emit } = await import('../src/events.js');
    expect(() => emit('audio:nobodyListens', { x: 1 })).not.toThrow();
  });

  /* 上面所有測試都把 media.js 換成替身，因此驗不到「真的有人訂閱」。
     這一條是唯一的原始碼契約：接收端還在，且沒有退回 window 事件。
     實際的重繪效果由真機驗證涵蓋（見 docs/開發與驗證.md §3）。 */
  it('media.js 仍訂閱 audio:busChanged，且兩端都無 window 事件殘留', () => {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const stripComments = s =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(read('src/media.js')).toMatch(/on\('audio:busChanged'/);
    expect(stripComments(read('src/media.js'))).not.toContain('audio-project:bus-change');
    expect(stripComments(read('src/mixer.js'))).not.toContain('audio-project:bus-change');
  });
});

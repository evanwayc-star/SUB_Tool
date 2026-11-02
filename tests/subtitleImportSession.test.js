// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const workflow=vi.hoisted(()=>({workspace:0,reads:new Map(),record:vi.fn()}));
vi.mock('../src/project.js',()=>({Project:{captureWorkspaceOwnership:()=>{const generation=workflow.workspace;return ()=>generation===workflow.workspace;}}}));
vi.mock('../src/util.js',async original=>({...await original(),readFile:vi.fn(file=>new Promise(resolve=>workflow.reads.set(file.name,resolve)))}));
vi.mock('../src/media.js',()=>({Media:{mpvMode:false,tracks:[],externalAudio:{list:()=>[]}},Wave:{}}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),layoutTimeline:vi.fn()}));
vi.mock('../src/history.js',()=>({History:{stack:[],hi:-1,cancelPreviewsForTargets:vi.fn()},recordHistory:workflow.record}));
vi.mock('../src/substyle.js',async original=>({...await original(),loadFonts:vi.fn().mockResolvedValue(undefined)}));
vi.mock('../src/audio-routing.js',()=>({AudioRouting:{}}));
vi.mock('../src/notes.js',()=>({getNotesGeneralFileData:vi.fn(),getNotesEdiusFileData:vi.fn()}));

let State,subio,ui;
const srt=text=>`1\n00:00:01,000 --> 00:00:02,000\n${text}\n`;
const bytes=text=>new TextEncoder().encode(text).buffer;

beforeAll(async()=>{
  document.body.innerHTML='<div id="modalBg"><div class="modal"><div id="modalTitle"></div><div id="modalBody"></div><div id="modalFoot"></div></div></div><div id="toast"></div>';
  ({State}=await import('../src/state.js'));
  ui=await import('../src/ui.js');
  subio=await import('../src/subio.js');
});
beforeEach(()=>{
  vi.useFakeTimers();
  ui.closeModal();
  workflow.workspace++;workflow.reads.clear();workflow.record.mockClear();
  Object.assign(State,{cues:[],tracks:[{name:'原軌',visible:true,locked:false}],mediaName:'',duration:0,fps:25,dropFrame:false});
});
afterEach(()=>{ui.closeModal();vi.clearAllTimers();vi.useRealTimers();});

describe('字幕匯入工作歸屬',()=>{
  it.each(['new','0'].flatMap(target=>
    ['srt','txt'].flatMap(kind=>
      ['partial','null','missing'].map(styleKind=>({target,kind,styleKind}))))
  )('$kind 匯入 $target 軌套用 $styleKind 樣式，缺欄使用預設且保留原文與時間',async({target,kind,styleKind})=>{
    const styles=await import('../src/substyle.js');
    const preset={name:'部分樣式',...(styleKind==='partial'?{style:{fontSize:48}}:styleKind==='null'?{style:null}:{})};
    styles.savePresets([preset]);
    Object.assign(State.tracks[0],{font:'舊字型',color:'#ff0000',outline:8,posX:10,posY:20,angle:30,vertical:true});
    try {
      const parsed=subio._parseSubtitleText(kind==='srt'?srt('第一行\n第二行'):'甲，原文\n乙！原稿',kind);
      const expected=parsed.map(({text,start,end})=>({text,start,end,timed:kind!=='txt'}));
      subio._openImportModal('匯入部分常用樣式',parsed,kind);
      document.getElementById('importTkSel').value=target;
      document.getElementById('importPresetSel').value=styles.presetIdentity(preset);
      document.querySelector('#modalFoot button.primary').click();
      expect(State.cues.map(({text,start,end,timed})=>({text,start,end,timed}))).toEqual(expected);
      for(const cue of State.cues)expect(styles.effStyle(cue,State.tracks[cue.track])).toEqual({...styles.STYLE_DEFAULTS,...preset.style});
      expect(styles.getPresets()).toEqual([preset]);
      expect(workflow.record).toHaveBeenCalledOnce();
    } finally {styles.savePresets([]);}
  });

  it('拖入空白分隔行含空格與 Tab 的 SRT，兩句皆可確認匯入並重新匯出',async()=>{
    State.mediaName='video.mov';
    const request=subio.importDropped({name:'spaced.srt'});
    workflow.reads.get('spaced.srt')(bytes('1\r\n00:00:01,000 --> 00:00:02,000\r\n第一句  文字\r\n下一行\r\n \t \r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n第二句\r\n'));
    await request;
    expect(document.getElementById('modalTitle').textContent).toContain('2 條');
    document.querySelector('#modalFoot button.primary').click();
    const expected=[{start:1,end:2,text:'第一句  文字\n下一行'},{start:3,end:4,text:'第二句'}];
    expect(State.cues.map(({start,end,text})=>({start,end,text}))).toEqual(expected);
    expect(workflow.record).toHaveBeenCalledOnce();
    const output=subio.getFileData('srt',State.cues,'重新匯出');
    const text=Buffer.from(output.content,'base64').subarray(2).toString('utf16le');
    expect(subio._parseSubtitleText(text,'srt')).toEqual(expected);
  });

  it('TXT 未定時原稿匯出自產 ASS 再匯入，同格率仍保留原稿的保留秒數',()=>{
    State.mediaName='video.mov';State.fps=25;
    subio._openImportModal('原稿',subio._parseSubtitleText('甲\n乙\n丙','txt'),'txt');
    document.querySelector('#modalFoot button.primary').click();
    const original=State.cues.map(({text,start,end,timed})=>({text,start,end,timed}));
    expect(original.map(cue=>cue.start)).toEqual([0,0.001,0.002]);
    const ass=subio.getFileData('ass',State.cues,'原稿');
    const text=Buffer.from(ass.content,'base64').subarray(2).toString('utf16le');
    const parsed=subio._parseSubtitleText(text,'ass');
    expect(parsed.subtool.cues).toHaveLength(3);
    State.cues=[];State.tracks=[{name:'原軌',visible:true,locked:false}];
    subio._openImportModal('重新匯入自產 ASS',parsed,'ass');
    document.querySelector('#modalFoot button.primary').click();
    expect(State.cues.map(({text,start,end,timed})=>({text,start,end,timed}))).toEqual(original);
  });

  it.each(['startFrame','endFrame','both'])('ASS 的 %s 與秒數矛盾時退回標準 Dialogue',field=>{
    State.mediaName='video.mov';State.fps=25;
    const source=[{id:'source',start:1,end:2,text:'標準時間',track:0,timed:true}];
    const file=subio.getFileData('ass',source,'原稿');
    const ass=Buffer.from(file.content,'base64').subarray(2).toString('utf16le');
    const metadata=structuredClone(subio._parseSubtitleText(ass,'ass').subtool);
    if(field==='startFrame') metadata.cues[0].startFrame=26;
    if(field==='endFrame') metadata.cues[0].endFrame=51;
    if(field==='both'){metadata.cues[0].startFrame=250;metadata.cues[0].endFrame=275;}
    const encoded=Buffer.from(JSON.stringify(metadata),'utf8').toString('base64');
    const damaged=ass.replace(/^; SUBTOOL-META:.*\r?\n/gm,'')
      .replace('[Script Info]',`[Script Info]\n; SUBTOOL-META:1:1/1:${encoded}`);
    const parsed=subio._parseSubtitleText(damaged,'ass');
    expect(parsed.subtool).toBeUndefined();
    subio._openImportModal('匯入損壞的 ASS',parsed,'ass');
    document.querySelector('#modalFoot button.primary').click();
    expect(State.cues[0]).toMatchObject({start:1,end:2,text:'標準時間',timed:true});
  });

  it.each(['new','0'])('合併多軌 ASS 由匯入視窗提交到 %s 目的軌，保留全部原稿與外觀',async target=>{
    const {SubFormats}=await import('../src/formats.js');
    const {effStyle}=await import('../src/substyle.js');
    const {getExactFps}=await import('../src/time.js');
    State.fps=29.97;
    const exact=getExactFps(State.fps);
    const tracks=[{name:'主字幕',fontSize:70,lineSpacing:1.7},{name:'直書',vertical:true,color:'#ffee00'}];
    const cues=[
      {start:30/exact,end:60/exact,text:'主字幕',track:0},
      {start:70/exact,end:100/exact,text:'直書\n原文',track:1,style:{fontSize:66}},
      {start:0,end:0,text:'尚未定時',track:1,timed:false},
    ];
    const parsed=subio._parseSubtitleText(SubFormats.toASS(cues,State.fps,tracks,1920,1080,{includeMetadata:true}),'ass');
    subio._openImportModal('合併 ASS',parsed,'ass');
    expect(document.getElementById('modalBody').textContent).toContain('合併到所選目的軌');
    expect(document.getElementById('importPresetSel')).toBeNull();
    document.getElementById('importTkSel').value=target;
    document.querySelector('#modalFoot button.primary').click();
    expect(State.cues.map(cue=>({start:cue.start,end:cue.end,text:cue.text,timed:cue.timed})))
      .toEqual(cues.map(cue=>({start:cue.start,end:cue.end,text:cue.text,timed:cue.timed!==false})));
    for(let index=0;index<cues.length;index++){
      const imported=State.cues[index];
      expect(effStyle(imported,State.tracks[imported.track])).toEqual(effStyle(cues[index],tracks[cues[index].track]));
    }
    expect(new Set(State.cues.map(cue=>cue.track)).size).toBe(1);
    expect(workflow.record).toHaveBeenCalledOnce();
  });

  it('短 SRT 匯入較低 FPS 後仍保有一格，TXT 保留未定時',()=>{
    State.fps=24;
    const parsed=subio._parseSubtitleText('1\n00:00:00,067 --> 00:00:00,100\n一格\n','srt');
    subio._openImportModal('短 SRT',parsed,'srt');
    document.getElementById('importTkSel').value='0';
    document.querySelector('#modalFoot button.primary').click();
    expect(State.cues[0].end-State.cues[0].start).toBeCloseTo(1/24,8);
    subio._openImportModal('未定時 TXT',subio._parseSubtitleText('未定時','txt'),'txt');
    document.getElementById('importTkSel').value='0';
    document.querySelector('#modalFoot button.primary').click();
    expect(State.cues[0].text).toBe('一格');
    expect(document.getElementById('modalBody').textContent).toContain('1');
    [...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent==='確認覆蓋').click();
    expect(State.cues.at(-1)).toMatchObject({start:0,end:0,timed:false});
  });
  it('同名不同folder在字幕匯入中套用指定identity',async()=>{
    const styles=await import('../src/substyle.js');
    styles.savePresets([{name:'same',group:'A',style:{fontSize:40}},{name:'same',group:'B',style:{fontSize:90}}]);
    try{
      subio._openImportModal('字幕匯入',[{start:1,end:2,text:'內容'}],'srt');
      const select=document.getElementById('importPresetSel');
      select.value=styles.presetIdentity(styles.getPresets()[1]);
      expect(select.selectedOptions[0].textContent).toBe('B / same');
      document.getElementById('importTkSel').value='0';
      document.querySelector('#modalFoot button.primary').click();
      expect(State.cues[0].style.fontSize).toBe(90);
    }finally{styles.savePresets([]);}
  });
  it.each(['escape','backdrop','replacement'])('FPS 提示經 %s 關閉會完成等待且不改專案',async action=>{
    const request=subio._prepareSubtitleImport(srt('取消'),'srt');
    expect(document.getElementById('importFpsSel')).not.toBeNull();
    const bg=document.getElementById('modalBg');
    if(action==='escape') bg.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    else if(action==='backdrop') bg.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
    else ui.openModal('新視窗','<p>保持新視窗</p>');
    expect(await request).toBeNull();
    expect(State.fps).toBe(25);
    expect(State.cues).toEqual([]);
    if(action==='replacement') expect(document.getElementById('modalTitle').textContent).toBe('新視窗');
  });

  it('較早的讀檔晚到時不能覆蓋新匯入，當前工作只提交一次',async()=>{
    State.mediaName='video.mov';
    const first=subio.importDropped({name:'first.srt'});
    const second=subio.importDropped({name:'second.srt'});
    workflow.reads.get('second.srt')(bytes(srt('新匯入')));
    await second;
    const confirm=document.querySelector('#modalFoot button.primary');
    workflow.reads.get('first.srt')(bytes(srt('舊匯入')));
    await first;
    expect(document.querySelector('#modalFoot button.primary')).toBe(confirm);
    confirm.click();confirm.click();
    expect(State.cues.map(cue=>cue.text)).toEqual(['新匯入']);
    expect(workflow.record).toHaveBeenCalledTimes(1);
  });

  it('等待期間換專案會撤銷讀檔結果，不能開啟舊匯入視窗',async()=>{
    const request=subio.importDropped({name:'old.srt'});
    workflow.workspace++;
    State.fps=24;
    ui.openModal('新專案視窗','<p>新專案</p>');
    workflow.reads.get('old.srt')(bytes(srt('舊字幕')));
    await request;
    expect(document.getElementById('modalTitle').textContent).toBe('新專案視窗');
    expect(State.fps).toBe(24);
    expect(State.cues).toEqual([]);
  });

  it('延遲初始化不能綁定替換視窗內同名的控制項',async()=>{
    State.mediaName='video.mov';
    subio._openImportModal('字幕匯入',[{start:1,end:2,text:'內容'}],'srt');
    ui.openModal('替換視窗','<select id="importTkSel"><option value="new">new</option><option value="0">0</option></select><div id="importNewTkRow" style="display:block"></div><input id="importNewTkName">');
    await vi.advanceTimersByTimeAsync(20);
    const select=document.getElementById('importTkSel');
    select.value='0';select.dispatchEvent(new Event('change'));
    expect(document.getElementById('importNewTkRow').style.display).toBe('block');
  });
});

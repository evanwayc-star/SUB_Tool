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

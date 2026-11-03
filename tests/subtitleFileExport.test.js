import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const writer=vi.hoisted(()=>({desktop:true,desk:{},download:vi.fn()}));
vi.mock('../src/state.js',async original=>({...await original(),
  get IS_DESKTOP(){return writer.desktop;},get DESK(){return writer.desk;},
}));
vi.mock('../src/util.js',async original=>({...await original(),downloadBytes:writer.download}));
import { prepareSubtitleFileExport } from '../src/subtitle-file-export.js';
import { buildXLSX } from '../src/xlsx-export.js';
import { SubFormats } from '../src/formats.js';

const {writeDirectoryFiles}=createRequire(import.meta.url)('../electron/directory-output.js');
const snapshot=(names=['對白'])=>({mediaName:'影片.mov',fps:25,dropFrame:false,
  tracks:names.map(name=>({name})),notes:[],
  cues:names.map((_,track)=>({id:`cue-${track}`,track,start:track,end:track+1,text:`第 ${track+1} 軌完整內容`,timed:true})),
});
const text=file=>Buffer.from(file.content,'base64').subarray(2).toString('utf16le');
beforeEach(()=>{writer.desktop=true;writer.desk={};writer.download.mockReset();});

describe('字幕檔案匯出的完整內容與完成結果',()=>{
  it.each([
    ['同名軌道',['對白','對白']],
    ['淨化後碰撞',['A/B','A:B']],
    ['大小寫及既有序號',['News','NEWS','News (2)']],
  ])('%s 的同批字幕各自保留完整內容',async(_label,names)=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'subtool-subtitle-batch-'));
    try {
      writer.desk={exportDirectory:vi.fn(async files=>{
        expect(writeDirectoryFiles(directory,files)).toEqual({written:files.length,blocked:0});return directory;
      })};
      const document=snapshot(names),before=structuredClone(document);
      const submission=prepareSubtitleFileExport(document,{formats:['srt']});
      const result=await submission.write();
      const actual=fs.readdirSync(directory).map(name=>fs.readFileSync(path.join(directory,name)).toString('base64'));
      expect(actual.sort()).toEqual(submission.files.map(file=>file.content).sort());
      expect(submission.files.map(text)).toEqual(document.cues.map(cue=>SubFormats.toSRT([cue])));
      expect(document).toEqual(before);
      expect(result).toMatchObject({status:'written',count:names.length,destination:directory,
        message:`已批次匯出 ${names.length} 個檔案至：${directory}`,kind:'ok'});
    } finally {
      expect(path.dirname(fs.realpathSync(directory))).toBe(fs.realpathSync(os.tmpdir()));
      fs.rmSync(directory,{recursive:true,force:true});
    }
  });

  it.each(['single','batch','xlsx'])('%s 寫入拒絕 EACCES 回傳失敗且不修改專案',async branch=>{
    const document=snapshot(branch==='batch'?['甲','乙']:['甲']),before=structuredClone(document);
    const reject=()=>Promise.reject(Object.assign(new Error('EACCES: permission denied'),{code:'EACCES'}));
    writer.desk={exportSub:vi.fn(reject),exportDirectory:vi.fn(reject)};
    const result=await prepareSubtitleFileExport(document,{formats:[branch==='xlsx'?'xlsx':'srt']}).write();
    expect(result).toMatchObject({status:'failed',count:0,kind:'err',message:expect.stringMatching(/匯出失敗.*EACCES/)});
    expect(document).toEqual(before);
  });

  it.each([1,2])('取消 %s 檔 native picker 不回報成功或失敗訊息',async count=>{
    writer.desk={exportSub:vi.fn().mockResolvedValue(null),exportDirectory:vi.fn().mockResolvedValue(null)};
    const result=await prepareSubtitleFileExport(snapshot(Array(count).fill('對白')),{formats:['srt']}).write();
    expect(result).toEqual({status:'cancelled',count:0});
  });

  it.each([1,2])('完成 %s 檔 native 寫入後才交出成功結果，重複 write 不重寫',async count=>{
    let finish;
    const pending=new Promise(resolve=>{finish=resolve;});
    writer.desk={exportSub:vi.fn(()=>pending),exportDirectory:vi.fn(()=>pending)};
    const submission=prepareSubtitleFileExport(snapshot(Array(count).fill('對白')),{formats:['srt']});
    const completed=submission.write();
    expect(submission.write()).toBe(completed);
    let settled=false;completed.then(()=>{settled=true;});await Promise.resolve();
    expect(settled).toBe(false);
    finish(count===1?'C:/picked/caption.srt':'C:/picked');
    expect(await completed).toMatchObject({status:'written',count,kind:'ok'});
    expect(writer.desk[count===1?'exportSub':'exportDirectory']).toHaveBeenCalledOnce();
  });

  it('XLSX native 成品使用真正工作簿 bytes，與其他格式共用完成結果',async()=>{
    writer.desk={exportSub:vi.fn().mockResolvedValue('C:/picked/captions.xlsx')};
    const document=snapshot(),submission=prepareSubtitleFileExport(document,{formats:['xlsx']});
    expect(await submission.write()).toMatchObject({status:'written',message:'已匯出：C:/picked/captions.xlsx'});
    const [name,b64,ext]=writer.desk.exportSub.mock.calls[0];
    expect(name).toMatch(/\.xlsx$/);expect(ext).toBe('xlsx');
    expect(Buffer.from(b64,'base64')).toEqual(Buffer.from(buildXLSX([{name:'對白',cues:document.cues}],25,false)));
  });

  it('網頁批次與 XLSX 都下載實際 bytes，保留重名及既有序號',async()=>{
    writer.desktop=false;
    const submission=prepareSubtitleFileExport(snapshot(['News','News','News (2)']),{formats:['srt','xlsx']});
    expect(await submission.write()).toMatchObject({status:'downloaded',count:4,message:'已下載 4 個檔案'});
    expect(writer.download.mock.calls.map(call=>call[1])).toEqual([
      'ST_影片_SUB_News.srt','ST_影片_SUB_News (3).srt','ST_影片_SUB_News (2).srt','ST_影片_SUB.xlsx',
    ]);
    expect(writer.download.mock.calls.map(call=>Buffer.from(call[0]).toString('base64'))).toEqual(submission.files.map(file=>file.content));
  });

  it('確認後的名稱、格率、內容、樣式與備註不再讀取 live 資料',async()=>{
    const document=snapshot(['保留','排除']);
    document.cues[0].start=1.48;document.cues[0].end=2.48;
    document.tracks[0].fontSize=48;
    document.notes=[{time:1.48,text:'保留備註',done:true}];
    writer.desk={exportDirectory:vi.fn().mockResolvedValue('C:/picked')};
    const submission=prepareSubtitleFileExport(document,{formats:['encore','ass','xlsx'],trackIndices:[0],noteFormats:['general','edius']});
    document.mediaName='新片.mp4';document.fps=30;document.dropFrame=true;
    document.cues[0].text='後來修改';document.tracks[0].fontSize=90;document.notes[0].text='後來備註';
    await submission.write();
    const files=writer.desk.exportDirectory.mock.calls[0][0];
    expect(files.every(file=>file.name.startsWith('ST_影片_'))).toBe(true);
    expect(text(files.find(file=>file.name.endsWith('.txt')))).toContain('00:00:01:12');
    const ass=SubFormats.parseASS(text(files.find(file=>file.ext==='ass')));
    expect(ass.subtool.fps).toBe(25);
    expect(ass.subtool.cues).toHaveLength(1);
    expect(ass.subtool.cues[0].text).toBe('第 1 軌完整內容');
    expect(ass.subtool.tracks[0].fontSize).toBe(48);
    for(const file of files.filter(file=>file.ext==='csv')){
      expect(text(file)).toContain('保留備註');expect(text(file)).toContain('00:00:01:12');
    }
    expect(Object.isFrozen(submission.files)).toBe(true);
    expect(submission.files.every(Object.isFrozen)).toBe(true);
  });

  it('混合格式全部成功前不寫出；ASS 無法保真時整批拒絕',()=>{
    const document=snapshot();document.cues[0].text='A'.repeat(1024*1024);
    writer.desk={exportSub:vi.fn(),exportDirectory:vi.fn()};
    expect(()=>prepareSubtitleFileExport(document,{formats:['srt','ass']})).toThrow(/ASS 無損匯出失敗/);
    expect(writer.desk.exportSub).not.toHaveBeenCalled();expect(writer.desk.exportDirectory).not.toHaveBeenCalled();
  });

  it('合併只包含所選軌道，按時間排序且保留原字幕與樣式',()=>{
    const document=snapshot(['甲','乙','丙']);
    document.cues[0].start=4;document.cues[0].end=5;
    const before=structuredClone(document);
    const submission=prepareSubtitleFileExport(document,{formats:['srt'],mergeFormats:['srt'],trackIndices:[0,2]});
    expect(submission.files).toHaveLength(1);expect(submission.files[0].name).toBe('ST_影片_SUB_甲+丙.srt');
    expect(SubFormats.parseSRT(text(submission.files[0])).map(cue=>cue.text)).toEqual(['第 3 軌完整內容','第 1 軌完整內容']);
    expect(document).toEqual(before);
  });

  it('空的選擇沒有成品，也不呼叫 writer',async()=>{
    const submission=prepareSubtitleFileExport(snapshot());
    expect(submission.files).toEqual([]);expect(await submission.write()).toEqual({status:'empty',count:0});
  });
});

import { IS_DESKTOP, DESK } from './state.js';
import { renderASS, SubFormats } from './formats.js';
import { buildXLSX } from './xlsx-export.js';
import { measureSubtitleBackgroundLayouts } from './subtitle-background-layout.js';
import { allocateExportFileNames } from './export-job-engine.js';
import { secToEncore } from './time.js';
import { encodeUTF16LE, bytesToB64, b64ToBytes, downloadBytes, baseName } from './util.js';

function textFile(name, text, ext, mime='text/plain;charset=utf-16le') {
  return {name, content:bytesToB64(encodeUTF16LE(text)), ext, mime};
}

function subtitleFile(kind, cues, trackName, document) {
  const name=String(trackName || '軌道').replace(/[\\/:*?"<>|]/g,'_');
  const prefix=`ST_${document.name}_SUB_${name}`;
  if(kind==='srt') return textFile(`${prefix}.srt`,SubFormats.toSRT(cues),'srt');
  if(kind==='ass') return textFile(`${prefix}.ass`,renderASS(cues,{
    fps:document.fps, dropFrame:document.dropFrame, tracks:document.tracks,
    includeMetadata:true, backgroundLayouts:measureSubtitleBackgroundLayouts(cues,document.tracks),
  }),'ass');
  if(kind==='encore') return textFile(`${prefix}.txt`,SubFormats.toEncore(cues,document.fps,document.dropFrame),'txt');
  return textFile(`${prefix}-NoTC.txt`,SubFormats.toTXT(cues),'txt');
}

function noteFile(kind, document) {
  const {notes,fps,dropFrame,name}=document;
  if(!notes.length) return null;
  if(kind==='general') {
    const csv=value=>{const text=String(value);return /[,"\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;};
    const lines=['狀態,時間,內容',...notes.map(note=>[
      note.done?'V':'K',secToEncore(note.time,fps,dropFrame),(note.text||'').replace(/\r\n?|\n/g,' '),
    ].map(csv).join(','))];
    return textFile(`ST_${name}_notes.csv`,lines.join('\r\n'),'csv','text/csv;charset=utf-16le');
  }
  const date=new Date();
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const pad=value=>String(value).padStart(2,'0');
  const created=`${days[date.getDay()]} ${months[date.getMonth()]} ${String(date.getDate()).padStart(2,' ')} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${date.getFullYear()}`;
  const lines=['# EDIUS Marker list','# Format Version 2',`# Created Date : ${created}`,'#','# No, Position, Duration, Comment',
    ...notes.map((note,index)=>`${index+1},"${secToEncore(note.time,fps,dropFrame)}", ,"${(note.text||'').replace(/"/g,'""')}"`)];
  return textFile(`ST_${name}_notes_Edius.csv`,lines.join('\r\n'),'csv','text/csv;charset=utf-16le');
}

async function writeFiles(files, desktop, desk) {
  if(!files.length) return {status:'empty',count:0};
  try {
    if(!desktop) {
      for(const file of files) downloadBytes(b64ToBytes(file.content),file.name,file.mime);
      const message=`已下載 ${files.length} 個檔案`;
      return {status:'downloaded',count:files.length,message,toast:message,kind:'ok'};
    }
    const file=files[0];
    const destination=files.length===1
      ? await desk.exportSub(file.name,file.content,file.ext)
      : await desk.exportDirectory(files);
    if(!destination) return {status:'cancelled',count:0};
    return {status:'written',count:files.length,destination,kind:'ok',
      message:files.length===1?`已匯出：${destination}`:`已批次匯出 ${files.length} 個檔案至：${destination}`,
      toast:files.length===1?`已匯出 ${baseName(destination)}`:`已批次匯出 ${files.length} 個檔案`};
  } catch(error) {
    const message='匯出失敗：'+(error?.message||String(error));
    return {status:'failed',count:0,message,toast:message,kind:'err'};
  }
}

// snapshot 由編輯 owner 排除未提交預覽並收尾暫存字幕時間；這個 module
// 只接收該份內容，不反查 live State。所有格式成功後才可關閉選項及寫出，
// 因此 ASS 保真失敗不會留下半批成品。字幕與備註跨同一個完成 seam。
export function prepareSubtitleFileExport(snapshot, {
  formats=[],trackIndices=(snapshot.tracks||[]).map((_,index)=>index),
  mergeFormats=[],includeTrackNames=true,noteFormats=[],
}={}) {
  const document=structuredClone({cues:snapshot.cues||[],tracks:snapshot.tracks||[],notes:snapshot.notes||[],
    fps:snapshot.fps,dropFrame:snapshot.dropFrame,
    name:(snapshot.mediaName?String(snapshot.mediaName).replace(/\.[^.]+$/,''):'subtitle').split('_')[0]});
  const selected=[...new Set(trackIndices)];
  if(formats.length && selected.some(index=>!Number.isInteger(index)||index<0||index>=document.tracks.length))
    throw new Error('所選字幕軌已變更，請重新開啟匯出視窗');
  const files=[];
  for(const kind of new Set(formats)) {
    if(!['srt','ass','encore','txt','xlsx'].includes(kind)) throw new Error('不支援的字幕格式：'+kind);
    const groups=selected.map(index=>({name:document.tracks[index]?.name||`軌道${index+1}`,
      cues:document.cues.filter(cue=>(cue.track||0)===index)})).filter(group=>group.cues.length);
    if(!groups.length) continue;
    if(kind==='xlsx') {
      files.push({name:`ST_${document.name}_SUB.xlsx`,content:bytesToB64(buildXLSX(groups,document.fps,document.dropFrame)),
        ext:'xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    } else if(mergeFormats.includes(kind)) {
      files.push(subtitleFile(kind,groups.flatMap(group=>group.cues).sort((a,b)=>a.start-b.start),groups.map(group=>group.name).join('+'),document));
    } else {
      for(const group of groups) files.push(subtitleFile(kind,group.cues,includeTrackNames?group.name:undefined,document));
    }
  }
  for(const kind of new Set(noteFormats)) {
    if(!['general','edius'].includes(kind)) throw new Error('不支援的備註格式：'+kind);
    const file=noteFile(kind,document);if(file) files.push(file);
  }
  const artifacts=Object.freeze(allocateExportFileNames(files).map(file=>Object.freeze(file)));
  const desktop=IS_DESKTOP,desk=DESK;
  let completion;
  return Object.freeze({files:artifacts,write:()=>completion??=(writeFiles(artifacts,desktop,desk))});
}

import { $ } from './dom.js';

const entries=[];
const limit=100;

function renderReport(){
  const list=$('statusErrorList');
  if(!list)return;
  if(!entries.length){
    const empty=document.createElement('li');
    empty.textContent='本次使用尚未收到錯誤回報。';
    list.replaceChildren(empty);
    return;
  }
  const rows=entries.map(({at,message,detail,labels})=>{
    const row=document.createElement('li');
    const time=document.createElement('time');
    time.dateTime=at.toISOString();
    time.textContent=at.toLocaleString('zh-TW',{hour12:false});
    const summary=document.createElement('strong');
    summary.textContent=message;
    row.append(time,summary);
    const context=labels.filter(label=>label!==message);
    if(detail&&detail!==message)context.push(detail);
    if(context.length){
      const description=document.createElement('p');
      description.textContent=context.join('\n');
      row.append(description);
    }
    return row;
  });
  list.replaceChildren(...rows);
}

export function recordStatusError(message,detail){
  const summary=String(message||'').trim();
  if(!summary)return;
  const diagnostic=String(detail||'').trim();
  // Each FFmpeg execution writes a unique log. Progress, recovery and the
  // invoking operation can all report the same failure before the UI settles.
  const marker=/\[LOG_PATH\]((?:[a-z]:[\\/]|\\\\|\/)[^\r\n]+?)\[\/LOG_PATH\]/i;
  const inline=summary.match(marker);
  const logPath=(diagnostic.match(marker)||inline)?.[1];
  const previous=logPath?entries.findIndex(entry=>entry.logPath===logPath):-1;
  const entry=previous>=0?entries.splice(previous,1)[0]:{labels:[],detail:'',logPath};
  const label=inline?summary.slice(0,inline.index).replace(/[：:\s]+$/u,'').trim():summary;
  if(label&&!entry.labels.includes(label))entry.labels.push(label);
  entry.at=new Date();
  if(!entry.message||!inline)entry.message=label||'FFmpeg 工作失敗';
  const evidence=diagnostic||(inline?summary.slice(inline.index):'');
  if(evidence.length>entry.detail.length)entry.detail=evidence;
  entries.unshift(entry);
  if(entries.length>limit)entries.pop();
  const button=$('stErrorsBtn'),count=$('stErrorCount');
  if(count){count.textContent=String(entries.length);count.hidden=false;}
  if(button){
    button.classList.add('has-errors');
    button.setAttribute('aria-label',`查看最近 ${entries.length} 筆錯誤回報`);
    button.title=button.getAttribute('aria-label');
  }
  renderReport();
}

export function openStatusErrorReport(openModal){
  openModal('錯誤回報','<ol class="status-error-list" id="statusErrorList" aria-label="本次使用的錯誤，最新在前"></ol>',undefined,{width:'min(560px, 94vw)'});
  renderReport();
}

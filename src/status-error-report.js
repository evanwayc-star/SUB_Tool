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
  const rows=entries.map(({at,message,detail})=>{
    const row=document.createElement('li');
    const time=document.createElement('time');
    time.dateTime=at.toISOString();
    time.textContent=at.toLocaleString('zh-TW',{hour12:false});
    const summary=document.createElement('strong');
    summary.textContent=message;
    row.append(time,summary);
    if(detail&&detail!==message){
      const description=document.createElement('p');
      description.textContent=detail;
      row.append(description);
    }
    return row;
  });
  list.replaceChildren(...rows);
}

export function recordStatusError(message,detail){
  const summary=String(message||'').trim();
  if(!summary)return;
  entries.unshift({at:new Date(),message:summary,detail:String(detail||'').trim()});
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

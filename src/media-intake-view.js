/* Status UI for project-owned Proxy/audio preparation; export controls have
   their own owner and never share this cancellation button. */
import { $ } from './dom.js';
import { on } from './events.js';
import { MediaIntakeJobs } from './media-intake-jobs.js';
import { setStatus, showToast } from './ui.js';

const starts=new Map();
export function bindMediaIntakeView(cancel){
  const render=state=>{
    const button=$('stProxyCancelBtn');
    if(button){
      button.style.display=state.count?'inline-block':'none';
      button.textContent=state.hasProxy?'取消 Proxy':'取消音訊處理';
      button.title='停止目前專案的 Proxy 與音訊快取工作，保留母素材與已完成快取';
    }
    if($('stMedia')) $('stMedia').style.display=state.count?'none':'';
    if(!state.count) starts.clear();
  };
  on('media:intakeJobs',render);
  render(MediaIntakeJobs.snapshot());
  const button=$('stProxyCancelBtn');
  if(button) button.onclick=()=>{
    if(!MediaIntakeJobs.snapshot().count) return;
    Promise.resolve().then(cancel).catch(error=>showToast('停止媒體處理失敗：'+(error?.message||error)));
  };
}

export function handleMediaIntakeProgress(data){
  // extractAudio has its own copy/AAC retry lifecycle and no cancellable intake
  // lease. Keep its terminal notifications; project intake always has an owner.
  const owned=data.sessionId!==undefined||data.requestId!==undefined;
  if(owned ? !MediaIntakeJobs.progress(data) : /^(ingest|stream)(?:-|$)/.test(String(data.jobId))) return false;
  if(data.done){
    starts.delete(data.requestId);
    const succeeded=data.outcome==='success';
    setStatus((data.label||'轉檔')+(succeeded?'完成':'失敗'),succeeded?'ok':'err');
    if(!MediaIntakeJobs.snapshot().count&&$('stMedia')) $('stMedia').style.display='';
    if(succeeded) window.dispatchEvent(new CustomEvent('desk:ingest-done',{detail:data}));
    return true;
  }
  if($('stMedia')) $('stMedia').style.display='none';
  if(data.pct===0||!starts.has(data.requestId)) starts.set(data.requestId,Date.now());
  const elapsed=Date.now()-starts.get(data.requestId);
  let time='';
  if(data.pct>0&&elapsed>1000){
    const remaining=Math.floor((elapsed/(data.pct/100)-elapsed)/1000);
    const fmt=seconds=>`${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
    time=` [已用 ${fmt(Math.floor(elapsed/1000))} / 剩餘 ${fmt(remaining)}]`;
  }
  // Background progress must not lock the status or unlock an active export.
  setStatus((data.label||'處理中')+'… '+data.pct+'%'+time,'busy');
  return true;
}

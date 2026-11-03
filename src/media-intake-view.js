/* Status UI for project-owned Proxy/audio preparation; export controls have
   their own owner and never share this cancellation button. */
import { $ } from './dom.js';
import { on } from './events.js';
import { MediaIntakeJobs } from './media-intake-jobs.js';
import { setStatus, setMediaIntakeStatus, showToast } from './ui.js';

const starts=new Map();
function verificationBytes({stage,processedBytes,totalBytes}){
  if(stage!=='source-verification'||!Number.isSafeInteger(processedBytes)||!Number.isSafeInteger(totalBytes)
    ||processedBytes<0||totalBytes<=0||processedBytes>totalBytes) return '';
  const [unit,scale]=totalBytes>=1e12?['TB',1e12]:totalBytes>=1e9?['GB',1e9]:totalBytes>=1e6?['MB',1e6]:totalBytes>=1e3?['KB',1e3]:['B',1];
  const format=bytes=>(bytes/scale).toFixed(scale===1?0:1);
  return `（${format(processedBytes)} / ${format(totalBytes)} ${unit}）`;
}

function progressText(data,requestId){
  const stage=data.stage||'transcoding',label=data.label||'處理中';
  const pct=typeof data.pct==='number'&&Number.isFinite(data.pct)?Math.max(0,Math.min(100,data.pct)):null;
  const identity=stage+'\0'+label;
  let timing=starts.get(requestId);
  if(!timing||timing.identity!==identity||(pct!=null&&timing.pct!=null&&pct<timing.pct)){
    timing={identity,start:Date.now(),pct};starts.set(requestId,timing);
  }
  timing.pct=pct;
  const elapsed=Date.now()-timing.start;
  let time='';
  if(pct>0&&elapsed>1000){
    const remaining=Math.max(0,Math.floor((elapsed/(pct/100)-elapsed)/1000));
    const fmt=seconds=>`${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
    time=` [已用 ${fmt(Math.floor(elapsed/1000))} / 預估剩餘 ${fmt(remaining)}]`;
  }
  return label+'…'+(pct==null?'':` ${Math.floor(pct)}%`)+verificationBytes(data)+time;
}

export function bindMediaIntakeView(cancel){
  let retryButton=$('stIntakeRetryBtn');
  if(!retryButton&&$('stProxyCancelBtn')?.parentNode){
    retryButton=document.createElement('button');retryButton.id='stIntakeRetryBtn';retryButton.type='button';
    retryButton.className='intake-retry';retryButton.style.display='none';
    $('stProxyCancelBtn').after(retryButton);
  }
  // Nested synchronous notifications can make the event's snapshot stale;
  // always render the intake owner's current state at delivery time.
  const render=()=>{
    const state=MediaIntakeJobs.snapshot();
    const recovery=state.recoveries?.[0];
    if(retryButton){
      retryButton.style.display=recovery&&!state.count?'inline-block':'none';
      retryButton.textContent=recovery?.status==='failed'?'重試背景處理':'繼續背景處理';
      retryButton.title='重新核對目前素材後，沿用可用的波形與 Proxy 快取';
      retryButton.onclick=()=>recovery&&MediaIntakeJobs.retry(recovery.id);
    }
    const button=$('stProxyCancelBtn');
    if(button){
      button.style.display=state.count?'inline-block':'none';
      button.textContent='停止背景處理';
      button.title='停止目前專案的 Proxy 與音訊快取工作，保留母素材與已完成快取';
    }
    if($('stMedia')) $('stMedia').style.display=state.count?'none':'';
    const jobs=state.jobs||[];
    const ids=new Set(jobs.map(job=>job.requestId));
    for(const id of starts.keys()) if(!ids.has(id)) starts.delete(id);
    const active=job=>job.progress&&!job.progress.queued;
    const visible=jobs.findLast(job=>active(job)&&job.progress.overall)
      ||jobs.findLast(job=>active(job)&&['waveform','source-waveform'].includes(job.progress.stage))
      ||jobs.findLast(active)||jobs.findLast(job=>job.progress)||jobs[0];
    if(visible){
      const data=visible.progress||{stage:'cache-check',label:visible.proxy?'檢查 Proxy 與音訊快取':'檢查音訊快取',pct:null};
      const other=(['waveform','source-waveform'].includes(data.stage)&&!visible.proxy)
        ? jobs.findLast(job=>job!==visible&&job.proxy&&active(job)) : null;
      const group=job=>job.path||job.requestId;
      const shown=new Set([visible,...(other?[other]:[])].map(group));
      const extraCount=new Set(jobs.filter(job=>!shown.has(group(job))).map(group)).size;
      const extra=extraCount?`（另有 ${extraCount} 項背景工作）`:'';
      if(other){
        const percent=pct=>typeof pct==='number'&&Number.isFinite(pct)?`${Math.floor(Math.max(0,Math.min(100,pct)))}% `:'';
        const stage=other.progress.stage;
        const label=stage==='source-verification'?'驗證母素材':stage==='cache-check'?'檢查快取':
          stage==='transcoding'&&String(other.progress.label||'').includes('Proxy')?'Proxy 轉檔':
            stage==='transcoding'?'音訊分析':other.progress.label||'處理中';
        const parts=[percent(data.pct)+'波形','｜',percent(other.progress.pct)+label+extra];
        const detail=progressText(data,visible.requestId)+'；'+progressText(other.progress,other.requestId)+extra;
        setMediaIntakeStatus(parts.join(''),'busy',detail,parts);
      }else setMediaIntakeStatus(progressText(data,visible.requestId)+extra);
    }else if(recovery){
      const name=String(recovery.path||'素材').split(/[\\/]/).pop();
      const waves=(recovery.saved?.locations||[]).map(location=>location.waveform).filter(wave=>wave&&Number.isSafeInteger(wave.completedSamples));
      const saved=waves.sort((a,b)=>b.completedSamples-a.completedSamples)[0];
      const summary=saved?` 保存紀錄：${(saved.completedSamples/4000).toFixed(1)} / ${(saved.totalSamples/4000).toFixed(1)} 秒，繼續時重驗。`:'';
      setMediaIntakeStatus(`${name}：${recovery.message}${summary}`,recovery.status==='failed'?'err':'',null);
    }else setMediaIntakeStatus(null);
  };
  on('media:intakeJobs',render);
  render();
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
    starts.delete(owned?data.requestId:data.jobId);
    const succeeded=data.outcome==='success';
    // 這只是來源的一段波形完成；整體進度由外層工作持有，也不是 Proxy ingest 完成事件。
    if(succeeded&&data.stage==='source-waveform') return true;
    setStatus((data.label||'轉檔')+(succeeded?'完成':'失敗')+(!succeeded&&data.errorMsg?'：'+data.errorMsg:''),succeeded?'ok':'err');
    if(!MediaIntakeJobs.snapshot().count&&$('stMedia')) $('stMedia').style.display='';
    if(succeeded) window.dispatchEvent(new CustomEvent('desk:ingest-done',{detail:data}));
    return true;
  }
  // 已持有的進度由 jobs snapshot 顯示，含本機波形整理；非 intake 的 extractAudio 保留舊入口。
  if(!owned){
    if($('stMedia')) $('stMedia').style.display='none';
    setStatus(progressText(data,data.jobId),'busy');
  }
  return true;
}

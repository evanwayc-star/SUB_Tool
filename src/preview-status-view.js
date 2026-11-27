import { PREVIEW_PROXY_HEIGHT, PREVIEW_PROXY_KBPS } from '../shared/preview-proxy.cjs';

const WAIT_TEXT={seeking:'定位中…',video:'等待影片…',audio:'等待聲道…'};

const PROXY_STATUS={
  idle:['未載入','目前沒有載入影片'],
  unsupported:['網頁版不支援','Proxy 背景轉檔需使用桌面版'],
  original:['使用原片','目前沒有已就緒的 Proxy，使用原始影片'],
  preparing:['準備中','正在檢查或準備 Proxy；尚無轉檔進度'],
  encoding:['轉檔中','正在產生同資料夾的 Proxy；進度不包含波形或音軌工作'],
  ready:['已就緒','Proxy 已完成，可供預覽使用'],
  failed:['失敗','Proxy 未能完成或無法讀取；可使用原片，或重試背景處理／Proxy 預覽'],
  stopped:['已停止','Proxy 背景處理已停止；可使用原片或繼續背景處理'],
};

export function bindProxyStatusView({root,readState}){
  let disposed=false;
  const update=()=>{
    if(disposed||!root)return;
    const current=readState(),state=Object.hasOwn(PROXY_STATUS,current?.state)?current.state:'idle';
    const [label,title]=PROXY_STATUS[state];
    const pct=typeof current.pct==='number'&&Number.isFinite(current.pct)?Math.floor(Math.max(0,Math.min(100,current.pct))):null;
    const text='Proxy：'+(state==='encoding'&&pct!==null?`轉檔 ${pct}%`:label);
    if(root.textContent!==text)root.textContent=text;
    root.title=title;root.dataset.state=state;
    root.dataset.tone=state==='failed'?'error':['preparing','encoding'].includes(state)?'busy':'normal';
  };
  update();return {update,dispose(){disposed=true;}};
}

export function bindPreviewStatusView({root,readState,setMode,seekBar,seek,now=Date.now}){
  const modeButtons=[...(root?.querySelectorAll('[data-preview-mode]')||[])];
  const modeGroup=root?.querySelector('[data-preview-modes]');
  const source=root?.querySelector('[data-preview-source]');
  const preparation=root?.querySelector('[data-preview-preparation]');
  const status=root?.querySelector('[data-preview-wait]');
  const returnButton=root?.querySelector('[data-preview-return]');
  let returnTime=null;
  let disposed=false,changing=false,operation=0,timer=null,waitingSince=null,notice='';
  const setText=(element,text)=>{if(element&&element.textContent!==text)element.textContent=text;};
  const clearWait=()=>{if(timer!==null)clearTimeout(timer);timer=null;waitingSince=null;};

  function update(){
    if(disposed)return;
    // Read at delivery time: a synchronous event subscriber may already have
    // superseded the event's payload with a new source or playback intention.
    const state=readState();
    modeGroup?.setAttribute('aria-busy',String(changing));
    for(const button of modeButtons){
      button.setAttribute('aria-pressed',String(button.dataset.previewMode===state.mode));
      button.disabled=changing||!state.available;
      button.title=!state.available?(state.phase==='idle'?'載入影片後即可選擇預覽模式':'目前無法切換預覽模式'):
        button.dataset.previewMode==='original'?'讀取原始影片，檢查原始畫質':`使用素材旁的 Proxy。新建規格最高 ${PREVIEW_PROXY_HEIGHT}p，目標 ${PREVIEW_PROXY_KBPS} kb/s`;
    }
    const sourceLabel=state.compositePreview?'合成預覽':state.phase==='idle'&&!state.available?'尚未載入影片':state.sourceKind==='stream'?'串流 Proxy':
      state.network?
        state.sourceKind==='original'?'NAS 原片':'NAS 預覽':state.sourceKind==='original'?'本機原片':'同資料夾預覽';
    setText(source,sourceLabel);
    const details=[];
    const stream=state.streamPreview;
    returnTime=null;
    if(stream){
      const stops=[];
      const labels=[];
      let closest=Infinity;
      const buffered=stream.ranges.some(([start,end])=>state.position>=start&&state.position<end);
      for(const [start,end] of stream.ranges){
        if(stream.duration>0){
          const left=100*start/stream.duration,right=100*end/stream.duration;
          stops.push(`transparent ${left}%, var(--cyan) ${left}% ${right}%, transparent ${right}%`);
        }
        labels.push(`${start.toFixed(1)}–${end.toFixed(1)} 秒`);
        const target=Math.max(start,Math.min(end-stream.frame,state.position));
        if(!buffered&&Math.abs(target-state.position)<closest){
          closest=Math.abs(target-state.position);returnTime=target;
        }
      }
      details.push(labels.length?'已緩衝 '+labels.join('、'):'等待首段串流畫面');
      if(!buffered&&labels.length)details.push('播放點超出已緩衝範圍');
      seekBar?.style.setProperty('--preview-buffer',stops.length?`linear-gradient(to right, transparent 0%, ${stops.join(', ')}, transparent 100%)`:'none');
    }else seekBar?.style.removeProperty('--preview-buffer');
    if(returnButton)returnButton.hidden=returnTime===null;
    if(state.compositePreview)details.push('合成可能使用 Proxy；檢查原始畫質請回到單一滿版、無合成效果的片段');
    if(!state.available&&state.phase!=='idle')details.push('目前無法切換預覽模式');
    if(state.available&&state.mode==='smooth'&&state.sourceKind==='original'&&!state.proxyAvailable){
      if(state.proxyFailed){
        const reason=state.proxyPreparation==='failed'?'Proxy 產生失敗':'Proxy 無法讀取';
        details.push(reason+'，暫用原片'+(state.canRetryProxy?'。按「Proxy 預覽」可重試':''));
      }else if(state.proxyPreparation==='stopped')details.push('Proxy 背景處理已停止，暫用原片');
      else if(state.proxyPreparation==='preparing'||state.proxyPreparation==='encoding')details.push('預覽準備中，暫用原片');
    }
    setText(preparation,details.join(' · '));if(preparation)preparation.hidden=!details.length;

    const waiting=Object.hasOwn(WAIT_TEXT,state.phase);
    if(waiting){
      if(waitingSince===null)waitingSince=now();
      if(timer===null&&now()-waitingSince<250)timer=setTimeout(()=>{timer=null;update();},250-(now()-waitingSince));
    }else clearWait();
    const text=notice||(state.phase==='error'?'預覽暫時無法使用':changing?'切換影像中…':waiting&&now()-waitingSince>=250?WAIT_TEXT[state.phase]:'');
    setText(status,text);if(status)status.hidden=!text;
    if(root){root.dataset.phase=state.phase;root.dataset.tone=notice||state.phase==='error'?'error':waiting?'waiting':'normal';}
  }

  async function changeMode(event){
    if(disposed||changing)return;
    const mode=event.currentTarget.dataset.previewMode,state=readState();
    if(mode!=='smooth'&&mode!=='original')return;
    if(!state.available)return;
    const token=++operation;
    changing=true;notice='';update();
    try{
      // false also means a newer seek/source superseded this operation. Real
      // presentation failures are reported by readState().phase, not this result.
      await setMode(mode);
    }catch(_){if(!disposed&&operation===token)notice='未能切換預覽模式，請重試';}
    finally{if(!disposed&&operation===token){changing=false;update();}}
  }

  for(const button of modeButtons)button.addEventListener('click',changeMode);
  const returnToBuffer=()=>{update();if(returnTime!==null)void seek?.(returnTime);};
  returnButton?.addEventListener('click',returnToBuffer);
  update();
  return {update,dispose(){
    if(disposed)return;disposed=true;operation++;clearWait();
    for(const button of modeButtons)button.removeEventListener('click',changeMode);
    returnButton?.removeEventListener('click',returnToBuffer);
  }};
}

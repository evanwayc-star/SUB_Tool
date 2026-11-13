const WAIT_TEXT={seeking:'定位中…',video:'等待影片…',audio:'等待聲道…'};

export function bindPreviewStatusView({root,readState,setMode,now=Date.now}){
  const modeButtons=[...(root?.querySelectorAll('[data-preview-mode]')||[])];
  const modeGroup=root?.querySelector('[data-preview-modes]');
  const source=root?.querySelector('[data-preview-source]');
  const preparation=root?.querySelector('[data-preview-preparation]');
  const status=root?.querySelector('[data-preview-wait]');
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
        button.dataset.previewMode==='original'?'讀取原始影片，檢查原始畫質':'使用同資料夾的 480p／1000 kb/s Proxy，適合流暢剪輯';
    }
    const sourceLabel=state.compositePreview?'合成預覽':state.phase==='idle'&&!state.available?'尚未載入影片':
      state.network?
        state.sourceKind==='original'?'NAS 原片':'NAS 預覽':state.sourceKind==='original'?'本機原片':'同資料夾預覽';
    setText(source,sourceLabel);
    const details=[];
    if(state.compositePreview)details.push('合成可能使用 Proxy；檢查原始畫質請回到單一滿版、無合成效果的片段');
    if(!state.available&&state.phase!=='idle')details.push('目前無法切換預覽模式');
    if(state.available&&state.mode==='smooth'&&state.sourceKind==='original'&&!state.proxyAvailable)
      details.push('預覽準備中，暫用原片');
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
  update();
  return {update,dispose(){
    if(disposed)return;disposed=true;operation++;clearWait();
    for(const button of modeButtons)button.removeEventListener('click',changeMode);
  }};
}

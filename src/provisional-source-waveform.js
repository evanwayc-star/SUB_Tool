/* 唯讀來源波形的獨立生命週期；不持有正式 clip、播放位置或 History。 */
let displayOwner=null;
export const registerProvisionalSourceWaveform=owner=>{
  const previous=displayOwner;displayOwner=owner;
  return ()=>{if(displayOwner===owner)displayOwner=previous;};
};
export const getProvisionalSourceWaveform=()=>displayOwner?.snapshot()||null;
export function createProvisionalSourceWaveform({jobs,bridge,decode,read,changed=()=>{},resolution=100}){
  let current=null;
  const clear=entry=>{
    if(current!==entry)return;
    current=null;entry.live=false;clearInterval(entry.timer);entry.resolveFirst(false);changed();
  };
  const snapshot=()=>current?.active()&&current.peaks ? {name:current.name,duration:current.duration,peaks:current.peaks} : null;
  function begin({path,name,audio,duration,owns}){
    if(current)clear(current);
    const entry={path,name,duration,live:true,peaks:null,sourceKey:null,finished:null};
    entry.firstReady=new Promise(resolve=>{entry.resolveFirst=resolve;});
    entry.active=()=>current===entry&&entry.live&&owns();
    entry.cancel=()=>clear(entry);
    entry.handoff=async(streamKey,transfer)=>{
      if(!entry.active()||typeof bridge.mediaSourceKey!=='function'){
        clear(entry);return false;
      }
      // 串流可比首段波形更早就緒；交接等待首段，但不阻塞呼叫端播放。
      if(!entry.peaks) await entry.firstReady;
      if(!entry.active()||!entry.peaks||entry.sourceKey!==streamKey){clear(entry);return false;}
      let key;
      try{key=await bridge.mediaSourceKey(path);}catch(_){clear(entry);return false;}
      if(!entry.active()||key!==entry.sourceKey){clear(entry);return false;}
      const peaks=entry.peaks;
      clear(entry);
      if(current||!owns())return false;
      return transfer(peaks)!==false;
    };
    current=entry;
    entry.timer=setInterval(()=>{if(!entry.active())clear(entry);},100);
    entry.finished=Promise.resolve().then(()=>jobs.prepareWaveform(async({owns:ownsJob,report})=>{
      const active=()=>entry.active()&&ownsJob();
      let position=0,combined=null,ignoreCached=false;
      while(active()&&position<duration){
        let result;
        try{
          result=await jobs.prepareSourceWaveform({path,audio,duration,start:position,length:Math.min(60,duration-position),...(ignoreCached?{ignoreCached:true}:{})});
          if(!active())return;
          if(!result?.wave||!/^[a-f0-9]{16}$/.test(result.sourceKey)||!Number.isFinite(result.duration)||result.duration<=0
            ||(entry.sourceKey&&entry.sourceKey!==result.sourceKey)) throw new Error('來源波形證據無效或已變更');
          const whole=result.start===0&&result.duration>=duration;
          if(!whole&&(Math.abs(result.start-position)>1e-6||result.duration>Math.min(60,duration-position)+1e-6)) throw new Error('來源波形時間不連續');
          entry.sourceKey=result.sourceKey;
          const url=await bridge.fileURL(result.wave);if(!active())return;
          const bytes=await read(url);if(!active())return;
          const peaks=decode(bytes,result.duration);
          if(!peaks){
            if(result.cached&&!ignoreCached){ignoreCached=true;continue;}
            throw new Error('來源波形無法解碼或內容不足');
          }
          ignoreCached=false;
          const end=whole?duration:Math.min(duration,result.start+result.duration);
          if(whole)entry.peaks=peaks;
          else{
            combined ||= new Float32Array(Math.ceil(duration*resolution)*2);
            const first=Math.round(result.start*resolution)*2,last=Math.min(Math.ceil(duration*resolution),Math.ceil(end*resolution))*2;
            combined.set(peaks.subarray(0,last-first),first);entry.peaks=combined.subarray(0,last);
          }
          position=end;entry.resolveFirst(true);changed();report({label:'優先產生波形',pct:position/duration*100,overall:true,queued:false});
        }finally{if(result?.temporary&&result.wave)try{await bridge.cleanupAudio(result.wave);}catch(_){}}
      }
    })).catch(()=>{clear(entry);}).finally(()=>{if(!entry.active()||!entry.peaks)clear(entry);});
    return entry;
  }
  return {begin,snapshot};
}

/* Pinned model bytes; checksums are verified for downloads and persistent cache hits. */
export const VOCAL_MODELS=Object.freeze({
  vocals:{name:'UVR-MDX-NET-Voc_FT',bytes:66762490,
    sha256:'534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111',
    url:'https://huggingface.co/Blane187/all_public_uvr_models/resolve/fddec39677560e41e3194f24a9e4c4cd32ef0e83/UVR-MDX-NET-Voc_FT.onnx'},
  speech:{name:'Silero VAD',bytes:2243022,
    sha256:'a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808',
    url:'https://huggingface.co/onnx-community/silero-vad/resolve/e71cae966052b992a7eca6b17738916ce0eca4ec/onnx/model.onnx'}
});

const MODEL_CACHE_TIMEOUT_MS=1500;

/** Storage is optional; a blocked cache must not consume the inference deadline. */
async function modelCache(mode,key,value){
  if(typeof indexedDB==='undefined') return null;
  return new Promise(resolve=>{
    let db=null,tx=null,settled=false;
    const finish=(result=null,abort=false)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      if(abort){try{tx?.abort();}catch(_){/* A completed transaction needs no cancellation. */}}
      db?.close();resolve(result);
    };
    const timer=setTimeout(()=>finish(null,true),MODEL_CACHE_TIMEOUT_MS);
    let open;
    try{open=indexedDB.open('subtool-vocal-models',1);}
    catch(_){finish();return;}
    open.onblocked=open.onerror=()=>finish();
    open.onupgradeneeded=()=>{
      db=open.result;tx=open.transaction;
      if(settled){
        // IDBOpenDBRequest cannot be cancelled. Stop a late upgrade and release it.
        try{tx.abort();}finally{db.close();}
        return;
      }
      try{db.createObjectStore('models');}
      catch(_){finish(null,true);}
    };
    open.onsuccess=()=>{
      db=open.result;
      if(settled){db.close();return;}
      try{
        tx=db.transaction('models',mode==='put'?'readwrite':'readonly');
        const store=tx.objectStore('models');
        const request=mode==='put'?store.put(value,key):store.get(key);
        tx.oncomplete=()=>finish(request.result??null);
        tx.onerror=tx.onabort=()=>finish();
      }catch(_){finish(null,true);}
    };
  });
}

export async function verifiedModel(model,onProgress=()=>{}){
  const valid=async bytes=>{
    if(!(bytes instanceof ArrayBuffer)||bytes.byteLength!==model.bytes) return false;
    const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    return [...hash].map(value=>value.toString(16).padStart(2,'0')).join('')===model.sha256;
  };
  try{
    const cached=await modelCache('get',model.sha256);
    if(await valid(cached)){onProgress({label:`${model.name} 已快取`,percent:0});return cached;}
  }catch(_){/* file origins / full storage still support a fresh download. */}
  onProgress({label:`下載 ${model.name}（首次使用）`,percent:0});
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),180000);
  let bytes;
  try{
    const response=await fetch(model.url,{signal:controller.signal});
    if(!response.ok) throw new Error(`模型下載失敗 (${response.status})，請稍後重試`);
    const reader=response.body?.getReader();
    if(!reader) bytes=await response.arrayBuffer();
    else{
      const output=new Uint8Array(model.bytes); let received=0;
      for(;;){
        const {done,value}=await reader.read(); if(done)break;
        if(received+value.length>output.length){await reader.cancel();throw new Error('模型檔案大小不正確');}
        output.set(value,received);received+=value.length;
        onProgress({label:`下載 ${model.name} ${Math.floor(received/model.bytes*100)}%`,percent:0});
      }
      bytes=output.buffer;
      if(received!==model.bytes) throw new Error('模型下載不完整，請重試');
    }
  }catch(error){
    if(controller.signal.aborted)throw new Error('模型下載逾時，請檢查網路後重試');
    throw error;
  }finally{clearTimeout(timeout);}
  if(!await valid(bytes)) throw new Error('模型完整性檢查失敗，請重試');
  try{await modelCache('put',model.sha256,bytes);}catch(_){/* Quota does not invalidate this analysis. */}
  return bytes;
}

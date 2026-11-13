// Runtime-only completed sidecar assets. Mother paths and project snapshots never change.
export const isNetworkPreviewPath = path => typeof path === 'string' && /^(?:\\\\|\/\/)[^/\\]/.test(path);

export function createPreviewSourceSession({changed=()=>{}}={}) {
  const sources=new Map();
  let generation=0;
  const current=record=>sources.get(record.key)===record&&record.generation===generation&&record.owns();
  function get(key){
    const record=sources.get(key);
    if(!record||!current(record))return null;
    return record;
  }
  function register(key,assets,owns){
    if(!key||!assets?.path||!assets?.proxy||!owns())return null;
    const previous=get(key);
    if(previous&&previous.assets.proxy===assets.proxy)return previous;
    const completed={...assets,channels:(assets.channels||[]).map(channel=>({...channel}))};
    const record={key,generation,owns,assets:completed};
    sources.set(key,record);changed();return record;
  }
  return {get,register,reset(){generation++;sources.clear();changed();}};
}

import {describe,it,expect,vi} from 'vitest';
import {createPreviewSourceSession,isNetworkPreviewPath} from '../src/preview-source-session.js';

const assets={path:'\\\\Storage\\DCP\\film.mov',proxy:'\\\\Storage\\DCP\\.subtool_Cache\\proxy.mp4',
  channels:[{file:'\\\\Storage\\DCP\\.subtool_Cache\\ch00.m4a',sourceStream:0,sourceChannel:0}]};

describe('completed sidecar preview sources',()=>{
  it('recognizes UNC sources without mistaking local mother files for network paths',()=>{
    expect(isNetworkPreviewPath(assets.path)).toBe(true);
    expect(isNetworkPreviewPath('//Storage/DCP/film.mov')).toBe(true);
    expect(isNetworkPreviewPath('C:/film.mov')).toBe(false);
  });
  it('uses the completed sidecar immediately and exposes no copy or activation operation',()=>{
    const localize=vi.fn(),changed=vi.fn();
    const session=createPreviewSourceSession({localize,changed});
    const record=session.register('source',assets,()=>true);
    expect(session.get('source').assets).toEqual(assets);
    expect(session.get('source').assets.channels).not.toBe(assets.channels);
    expect(session.prepare).toBeUndefined();expect(session.activate).toBeUndefined();
    expect(localize).not.toHaveBeenCalled();expect(changed).toHaveBeenCalledOnce();
    expect(session.register('source',assets,()=>true)).toBe(record);
    expect(changed).toHaveBeenCalledOnce();
  });
  it.each(['reset','replacement','ownership'])('revokes the old source after %s without changing the mother',action=>{
    let owns=true;const session=createPreviewSourceSession();
    const before=JSON.stringify(assets),old=session.register('source',assets,()=>owns);
    if(action==='reset')session.reset();
    if(action==='replacement')session.register('source',{...assets,proxy:'\\\\Storage\\new-proxy.mp4'},()=>true);
    if(action==='ownership')owns=false;
    expect(session.get('source')).not.toBe(old);
    expect(JSON.stringify(assets)).toBe(before);
    if(action!=='replacement')expect(session.get('source')).toBeNull();
  });
  it('publishes the record before a synchronous observer reads or replaces it',()=>{
    let observed;const session=createPreviewSourceSession({changed:()=>{observed=session.get('source');}});
    const registered=session.register('source',assets,()=>true);
    expect(observed).toBe(registered);
    session.reset();expect(observed).toBeNull();
    expect(session.register('stale',assets,()=>false)).toBeNull();
  });
});

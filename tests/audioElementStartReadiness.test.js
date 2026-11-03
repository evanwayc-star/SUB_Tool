// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createAudioEngineForTest} from '../src/audio-engine.js';
import {resetPlayerAdapter} from '../src/media-player-adapter.js';

const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
const gain=()=>({...node(),gain:{value:1,cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()}});

describe('多聲道起播等待的生命週期',()=>{
  let engine,elements,epoch;
  beforeEach(()=>{vi.useFakeTimers();epoch=Date.now();elements=[];});
  afterEach(()=>{engine?.stopElements();resetPlayerAdapter(null);vi.useRealTimers();});

  function audio(delay){
    const element=new EventTarget();
    let position=0,startedAt=null,seekTimer=null;
    const pendingPlay=[];
    Object.assign(element,{src:`file:///channel-${elements.length}.m4a`,readyState:4,seeking:false,paused:true,duration:30,playbackRate:1,readinessDelay:delay});
    Object.defineProperty(element,'currentTime',{
      get:()=>position+(startedAt===null?0:(Date.now()-startedAt)/1000*element.playbackRate),
      set:value=>{
        position=value;startedAt=null;element.seeking=true;element.readyState=1;
        clearTimeout(seekTimer);
        const complete=()=>{
          element.seeking=false;element.readyState=4;
          element.dispatchEvent(new Event('seeked'));element.dispatchEvent(new Event('canplay'));
          if(!element.paused){startedAt=Date.now();for(const pending of pendingPlay.splice(0))pending.resolve();}
        };
        if(element.immediateSeek)complete();else seekTimer=setTimeout(complete,element.readinessDelay);
      },
    });
    element.play=vi.fn(()=>{
      element.paused=false;
      if(element.seeking||element.readyState<3)return new Promise((resolve,reject)=>pendingPlay.push({resolve,reject}));
      startedAt=Date.now();
      return Promise.resolve();
    });
    element.pause=vi.fn(()=>{
      position=element.currentTime;startedAt=null;element.paused=true;
      for(const pending of pendingPlay.splice(0))pending.reject(new DOMException('paused','AbortError'));
    });
    element.load=vi.fn();elements.push(element);return element;
  }

  function setup({moving=true,fade=false,reverse=false}={}){
    const originals=[audio(40),audio(80)];
    const tracks=originals.map(el=>({kind:'element',source:'video',el,gain:gain()}));
    const clip={id:'one',in:0,out:30,offset:0,speed:1,reverse,...(fade?{fadeIn:1}:{})};
    const env={time:4,tracks};
    const time=()=>env.time+(moving?(Date.now()-epoch)/1000:0);
    const gains=[];
    const context={get currentTime(){return (Date.now()-epoch)/1000;},state:'running',destination:{},
      createGain:()=>{const created=gain();gains.push(created);return created;},createAnalyser:()=>({...node(),fftSize:32}),
      createMediaElementSource:node,createChannelSplitter:node};
    const createAudio=()=>audio(elements.length%2?80:40);
    engine=createAudioEngineForTest({createContext:()=>context,createAudio,reverseOptions:{createAudio}});
    engine.ensureCtx();
    engine.bind({tracks:()=>env.tracks,playing:()=>true,seqOn:()=>true,timelineTime:time,
      sourcePlaybacksFor:(_source,t)=>[{clip,sourceTime:reverse?clip.out-t:t,offset:t,reverse,rate:1}],sourceTimeFor:(_source,t)=>t});
    return {originals,env,time,clip,gains,context};
  }

  it('每次 seek 都等待 NAS 資料時仍能起播，不無限追趕持續前進的 presenter',async()=>{
    setup();engine.startElements(4,4);
    await vi.advanceTimersByTimeAsync(1000);
    expect(elements.map(element=>element.play.mock.calls.length)).toEqual([1,1]);
    expect(Math.abs(elements[0].currentTime-elements[1].currentTime)).toBeLessThan(.01);
  });

  it('帶淡入的同源聲道 clone 也必須等共同就緒才起播',async()=>{
    const {originals}=setup({moving:false,fade:true});engine.startElements(4,4);
    await vi.advanceTimersByTimeAsync(100);
    const clones=elements.filter(element=>!originals.includes(element));
    expect(clones).toHaveLength(2);
    expect(clones.every(element=>!element.paused)).toBe(true);
    expect(Math.abs(clones[0].currentTime-clones[1].currentTime)).toBeLessThan(.01);
  });

  it.each(['stop','replace','remove','hide','error'])('%s 撤銷等待中的共同起播，遲到 canplay 不得啟動舊聲音',async action=>{
    const {env,originals}=setup({moving:false});engine.startElements(4,4);
    await vi.advanceTimersByTimeAsync(50);
    if(action==='stop')engine.stopElements();
    if(action==='replace')originals[1].src='file:///replacement.m4a';
    if(action==='remove')env.tracks=[];
    if(action==='hide')env.tracks[1]._srcHidden=true;
    if(action==='error')originals[1].dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(100);
    expect(originals.map(element=>element.play.mock.calls.length)).toEqual([0,0]);
    expect(originals.every(element=>element.paused)).toBe(true);
  });

  it('較新的 seek 取得整組資格，舊 canplay 不得提前播放舊目標',async()=>{
    const {env,originals}=setup({moving:false});engine.startElements(4,4);
    await vi.advanceTimersByTimeAsync(20);
    env.time=8;engine.startElements(8,8);
    originals[1].dispatchEvent(new Event('canplay'));
    await vi.advanceTimersByTimeAsync(60);
    expect(originals.map(element=>element.play.mock.calls.length)).toEqual([0,0]);
    await vi.advanceTimersByTimeAsync(20);
    expect(originals.map(element=>element.play.mock.calls.length)).toEqual([1,1]);
    expect(originals.map(element=>element.currentTime)).toEqual([8,8]);
  });

  it('逾時撤銷整組後可重新播放，舊 timer 與 canplay 不能停止新起播',async()=>{
    const {env,originals}=setup({moving:false});originals[1].readinessDelay=11000;engine.startElements(4,4);
    await vi.advanceTimersByTimeAsync(10500);
    expect(originals.every(element=>element.paused)).toBe(true);
    expect(originals.map(element=>element.play.mock.calls.length)).toEqual([0,0]);
    originals[1].readinessDelay=80;env.time=8;engine.startElements(8,8);
    await vi.advanceTimersByTimeAsync(80);
    expect(originals.map(element=>element.play.mock.calls.length)).toEqual([1,1]);
    await vi.advanceTimersByTimeAsync(11000);
    expect(originals.every(element=>!element.paused)).toBe(true);
  });

  it('準備完成只交出就緒證據，必須由同一 owner commit 才能共同起播一次',async()=>{
    const {originals}=setup({moving:false});
    const plan=engine.prepareElements(4,4);
    await vi.advanceTimersByTimeAsync(80);
    await expect(plan.ready).resolves.toEqual({status:'ready'});
    expect(originals.map(element=>element.play.mock.calls.length)).toEqual([0,0]);
    await expect(plan.commit()).resolves.toBe(true);
    expect(plan.commit()).toBe(false);
    expect(originals.map(element=>element.play.mock.calls.length)).toEqual([1,1]);
    expect(originals.map(element=>element.currentTime)).toEqual([4,4]);
  });

  it.each(['cancel','stop','owner'])('%s 使已 ready 的計畫失效，晚到 presenter play ACK 不可 commit',async action=>{
    const {originals}=setup({moving:false});let owns=true;
    const plan=engine.prepareElements(4,4,{owns:()=>owns});
    await vi.advanceTimersByTimeAsync(80);
    await expect(plan.ready).resolves.toEqual({status:'ready'});
    if(action==='cancel')plan.cancel();
    if(action==='stop')engine.stopElements();
    if(action==='owner')owns=false;
    expect(plan.commit()).toBe(false);
    expect(originals.map(element=>element.play.mock.calls.length)).toEqual([0,0]);
    expect(originals.every(element=>element.paused)).toBe(true);
  });

  it.each(['error','timeout'])('%s 明確回報 failed，不能把準備失敗當作 ready',async action=>{
    const {originals}=setup({moving:false});
    if(action==='timeout')originals[1].readinessDelay=11000;
    const plan=engine.prepareElements(4,4);
    await vi.advanceTimersByTimeAsync(50);
    if(action==='error')originals[1].dispatchEvent(new Event('error'));
    if(action==='timeout')await vi.advanceTimersByTimeAsync(9950);
    await expect(plan.ready).resolves.toMatchObject({status:'failed',error:expect.any(Error)});
    expect(plan.commit()).toBe(false);
    await vi.advanceTimersByTimeAsync(11000);
    expect(originals.map(element=>element.play.mock.calls.length)).toEqual([0,0]);
  });

  it('取消 preparing 時交回 cancelled，遲到事件不會誤判成失敗或完成',async()=>{
    const {originals}=setup({moving:false});const plan=engine.prepareElements(4,4);
    plan.cancel();
    await expect(plan.ready).resolves.toEqual({status:'cancelled'});
    await vi.advanceTimersByTimeAsync(100);
    expect(plan.commit()).toBe(false);
    expect(originals.map(element=>element.play.mock.calls.length)).toEqual([0,0]);
  });

  it('任一聲道 play 拒絕時整組停止並回報失敗',async()=>{
    const {originals}=setup({moving:false});const plan=engine.prepareElements(4,4);
    await vi.advanceTimersByTimeAsync(80);await plan.ready;
    originals[1].play.mockRejectedValueOnce(new Error('decoder failed'));
    await expect(plan.commit()).rejects.toThrow('decoder failed');
    expect(originals.every(element=>element.paused)).toBe(true);
  });

  it('已失去資格的 play Promise 晚到拒絕不得暫停新的起播',async()=>{
    const {env,originals}=setup({moving:false});let rejectOld;
    const plan=engine.prepareElements(4,4);
    await vi.advanceTimersByTimeAsync(80);await plan.ready;
    originals[0].play.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{rejectOld=reject;}));
    const oldCommit=plan.commit();
    env.time=8;const latest=engine.prepareElements(8,8);
    await vi.advanceTimersByTimeAsync(80);await latest.ready;
    await expect(latest.commit()).resolves.toBe(true);
    rejectOld(new Error('old request failed'));
    await expect(oldCommit).resolves.toBe(false);
    expect(originals.every(element=>!element.paused)).toBe(true);
  });

  it('ready 後 error 也會撤銷 commit 資格，不能沿用已 resolve 的證據',async()=>{
    const {originals}=setup({moving:false});const plan=engine.prepareElements(4,4);
    await vi.advanceTimersByTimeAsync(80);await plan.ready;
    originals[1].dispatchEvent(new Event('error'));
    expect(plan.commit()).toBe(false);
    expect(originals.map(element=>element.play.mock.calls.length)).toEqual([0,0]);
  });

  it('取消舊計畫的 pause 同步建立並起播新計畫時，舊迴圈不能暫停新聲道',async()=>{
    const {env,originals}=setup({moving:false});const old=engine.prepareElements(4,4);
    await vi.advanceTimersByTimeAsync(80);await old.ready;
    for(const element of originals)element.immediateSeek=true;
    const originalPause=originals[0].pause.getMockImplementation();let latestCommit;
    originals[0].pause.mockImplementationOnce(()=>{
      originalPause();env.time=8;const latest=engine.prepareElements(8,8);latestCommit=latest.commit();
    });
    old.cancel();await expect(latestCommit).resolves.toBe(true);
    expect(originals.every(element=>!element.paused)).toBe(true);
    expect(originals.map(element=>element.currentTime)).toEqual([8,8]);
  });

  it('第一聲道 play 同步換成新 seek 時，舊迴圈不能再播放第二聲道',async()=>{
    const {env,originals}=setup({moving:false});const old=engine.prepareElements(4,4);let latest;
    await vi.advanceTimersByTimeAsync(80);await old.ready;
    originals[0].play.mockImplementationOnce(()=>{
      env.time=8;latest=engine.prepareElements(8,8);return Promise.resolve();
    });
    expect(await old.commit()).toBe(false);
    expect(originals[1].play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(80);await latest.ready;
    await expect(latest.commit()).resolves.toBe(true);
    expect(originals.map(element=>element.currentTime)).toEqual([8,8]);
  });

  it('反向音軌的淡入 ramp 也從 commit 起算，不在等待可播期間先跑掉',async()=>{
    const {env,clip,gains,context}=setup({moving:false,fade:true,reverse:true});env.time=.25;
    await Promise.all(env.tracks.map((track,index)=>engine.prepareReverseTrack(track,{key:`reverse-${index}`,
      clip,start:0,end:30,load:async()=>({url:`file:///reverse-${index}.wav`})})));
    for(const entry of gains)entry.gain.linearRampToValueAtTime.mockClear();
    const plan=engine.prepareElements(29.75,.25);
    expect(gains.flatMap(entry=>entry.gain.linearRampToValueAtTime.mock.calls)).toEqual([]);
    await vi.advanceTimersByTimeAsync(80);await plan.ready;
    await expect(plan.commit()).resolves.toBe(true);
    const ramps=gains.flatMap(entry=>entry.gain.linearRampToValueAtTime.mock.calls);
    expect(ramps).toHaveLength(2);
    expect(ramps.every(([value,at])=>value===1&&Math.abs(at-(context.currentTime+.75))<1e-9)).toBe(true);
  });

  it('clone 的 onCommit gain 回呼同步換 seek 時，舊計畫不可繼續 play 新計畫的元素',async()=>{
    const {env,originals,gains}=setup({moving:false,fade:true});const old=engine.prepareElements(4,4);let latest;
    await vi.advanceTimersByTimeAsync(80);await old.ready;
    gains[1].gain.cancelScheduledValues.mockImplementationOnce(()=>{
      env.time=8;latest=engine.prepareElements(8,8);
    });
    expect(await old.commit()).toBe(false);
    const clones=elements.filter(element=>!originals.includes(element));
    expect(clones.map(element=>element.play.mock.calls.length)).toEqual([0,0]);
    await vi.advanceTimersByTimeAsync(80);await latest.ready;
    await expect(latest.commit()).resolves.toBe(true);
    expect(clones.map(element=>element.currentTime)).toEqual([8,8]);
  });

  it('播放拒絕的清理 pause 同步起播新計畫時，舊清理不可停止新聲道',async()=>{
    const {env,originals}=setup({moving:false});const old=engine.prepareElements(4,4);let latestCommit;
    await vi.advanceTimersByTimeAsync(80);await old.ready;
    for(const element of originals)element.immediateSeek=true;
    const originalPause=originals[0].pause.getMockImplementation();
    originals[0].pause.mockImplementationOnce(()=>{
      originalPause();env.time=8;const latest=engine.prepareElements(8,8);latestCommit=latest.commit();
    });
    originals[1].play.mockRejectedValueOnce(new Error('old decoder failed'));
    const outcome=await Promise.resolve(old.commit()).catch(error=>error);
    await expect(latestCommit).resolves.toBe(true);
    expect(originals.every(element=>!element.paused)).toBe(true);
    expect(outcome).toBe(false);
  });

  it('慢 ACK 後的漂移修正也共同等待聲道，不因再次 NAS seek 把同源聲音拆開',async()=>{
    const {env,originals}=setup({moving:false});
    originals[0].readinessDelay=200;originals[1].readinessDelay=400;
    const plan=engine.prepareElements(4,4);
    await vi.advanceTimersByTimeAsync(400);await plan.ready;
    await expect(plan.commit()).resolves.toBe(true);
    // Native play ACK 或重準備期間 presenter 已前進，與聲道相差 400 ms。
    // 下一個 tick 會校正；每次 NAS seek 都重新等資料，不能只慢第一次。
    env.time=4.4;engine.syncElements(env.time);
    await vi.advanceTimersByTimeAsync(400);
    expect(originals.every(element=>!element.paused)).toBe(true);
    expect(Math.abs(originals[0].currentTime-originals[1].currentTime)).toBeLessThan(.01);
    const resumed=originals.map(element=>element.currentTime);
    await vi.advanceTimersByTimeAsync(100);
    originals.forEach((element,index)=>expect(element.currentTime-resumed[index]).toBeCloseTo(.1,8));
  });

  it.each(['prepare','stop'])('外層 %s 的取消回呼同步建立更新播放意圖時，不得返回後再覆寫較新計畫',async action=>{
    const {env,originals}=setup({moving:false});const old=engine.prepareElements(4,4);let latestCommit,outer;
    await vi.advanceTimersByTimeAsync(80);await old.ready;
    for(const element of originals)element.immediateSeek=true;
    const originalPause=originals[0].pause.getMockImplementation();
    originals[0].pause.mockImplementationOnce(()=>{
      originalPause();env.time=8;const latest=engine.prepareElements(8,8);latestCommit=latest.commit();
    });
    if(action==='prepare')outer=engine.prepareElements(6,6);
    else engine.stopElements();
    await expect(latestCommit).resolves.toBe(true);
    expect(originals.every(element=>!element.paused)).toBe(true);
    expect(originals.map(element=>element.currentTime)).toEqual([8,8]);
    if(outer){await expect(outer.ready).resolves.toMatchObject({status:'cancelled'});expect(outer.commit()).toBe(false);}
  });
});

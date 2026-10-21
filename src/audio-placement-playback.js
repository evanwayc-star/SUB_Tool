/* 同一母素材的疊合片段需要獨立的 element 時鐘，但仍共用來源聲道的
   gain／analyser。clone、metadata 回呼與釋放全部由 AudioEngine 的此 owner 管理。 */
import {fadeWindow} from '../shared/clip-fade.cjs';
import {getPlayerAdapter} from './media-player-adapter.js';
import {setMediaElementSource} from './media-intake-engine.js';

export class PlacementAudioGains {
  constructor(context){this.context=context;this.entries=new Map();}
  for(track,playback,time,{schedule=false}={}){
    const clip=playback?.clip;if(!clip)return track.gain;
    let entries=this.entries.get(track);if(!entries){entries=new Map();this.entries.set(track,entries);}
    let entry=entries.get(clip);
    if(!entry){entry={input:this.context.createGain(),output:this.context.createGain()};entry.input.connect(entry.output);entry.output.connect(track.gain);entries.set(clip,entry);}
    const window=fadeWindow(clip),local=Math.max(0,time-(Number(clip.offset)||0)+(Number(clip.fadeSourceOffset)||0));
    const rate=(playback.rate||Number(clip.speed)||1)/(Number(clip.speed)||1),now=this.context.currentTime;
    const set=(param,value)=>{param.cancelScheduledValues?.(now);param.value=value;param.setValueAtTime?.(value,now);};
    set(entry.input.gain,window.fadeIn?Math.min(1,local/window.fadeIn):1);
    set(entry.output.gain,window.fadeOut?Math.max(0,Math.min(1,(window.length-local)/window.fadeOut)):1);
    if(schedule){
      if(window.fadeIn&&local<window.fadeIn)entry.input.gain.linearRampToValueAtTime?.(1,now+(window.fadeIn-local)/rate);
      if(window.fadeOut&&local<window.length){
        if(local<window.fadeOutStart)entry.output.gain.setValueAtTime?.(1,now+(window.fadeOutStart-local)/rate);
        entry.output.gain.linearRampToValueAtTime?.(0,now+(window.length-local)/rate);
      }
      const end=(Number(clip.out)-Number(clip.in))/(Number(clip.speed)||1)+Number(clip.offset||0);
      if(Number.isFinite(end))entry.output.gain.setValueAtTime?.(0,now+Math.max(0,end-time)/rate);
    }
    return entry.input;
  }
  prune(tracks,owns){
    for(const [track,entries] of this.entries)for(const [clip,entry] of entries){
      if(tracks.includes(track)&&owns(clip))continue;
      entry.input.disconnect();entry.output.disconnect();entries.delete(clip);if(!entries.size)this.entries.delete(track);
    }
  }
  clear(){for(const entries of this.entries.values())for(const entry of entries.values()){entry.input.disconnect();entry.output.disconnect();}this.entries.clear();}
}

export class ElementPlacementPlayback {
  constructor(context,{environment,playbacks,gainFor,createAudio=()=>new Audio()}){
    this.context=context;this.environment=environment;this.playbacks=playbacks;this.createAudio=createAudio;
    this.gainFor=gainFor;
    this.groups=new Map();
  }
  element(track,playback,playbacks){
    if(!playback) return track.el;
    if(playbacks.length===1&&!playback.clip?.fadeIn&&!playback.clip?.fadeOut){
      // 回到原始載體前釋放同片段 clone，避免疊合尾端留下兩份相同聲音。
      this.release(track.el,playback.clip);
      return track.el;
    }
    const original=track.el;
    let entries=this.groups.get(original);
    if(!entries){entries=new Map();this.groups.set(original,entries);}
    let group=entries.get(playback.clip);
    if(group) return group.el;
    const tracks=this.environment().tracks().filter(item=>item.kind==='element'&&item.el===original);
    const el=this.createAudio();
    group={el,original,clip:playback.clip,tracks,url:original.currentSrc||original.src,node:null,splitter:null,running:false,pendingStart:false};
    entries.set(playback.clip,group);
    try{
      el.preload='auto';setMediaElementSource(el,group.url);
      group.node=this.context.createMediaElementSource(el);
      group.splitter=this.context.createChannelSplitter(Math.max(1,tracks.length));
      group.node.connect(group.splitter);
      tracks.forEach((channel,index)=>{
        group.splitter.connect(this.gainFor(channel,playback,this.environment().timelineTime()),index);
        if(channel.analyser) group.splitter.connect(channel.analyser,index);
      });
      // ready 只完成尚待 metadata 的起播；seek 本身也會再觸發 canplay。
      group.ready=()=>{if(group.running&&group.pendingStart&&entries.get(group.clip)===group)this.syncGroup(group);};
      el.addEventListener('loadedmetadata',group.ready);el.addEventListener('canplay',group.ready);
      return el;
    }catch(error){this.release(original,playback.clip);throw error;}
  }
  playback(group,time){
    return this.playbacks(group.tracks[0],time).find(item=>item?.clip===group.clip&&!item.reverse);
  }
  cancelSeek(group){
    const request=group.seekRequest;group.seekRequest=null;
    request?.controller.abort();getPlayerAdapter().cancelElementSeek(group.el);
  }
  syncGroup(group,start=false,time=this.environment().timelineTime()){
    const env=this.environment(),playback=this.playback(group,time);
    if(!playback||env.transportMuted()||!group.tracks.some(track=>!track._srcHidden)){
      group.running=false;group.pendingStart=false;this.cancelSeek(group);try{group.el.pause();}catch(_){}return;
    }
    if(start){group.running=true;group.pendingStart=true;}
    if(!group.running||!(group.el.readyState>=1||Number.isFinite(group.el.duration))) return;
    const shouldStart=group.pendingStart;
    group.pendingStart=false;
    try{
      for(const track of group.tracks)this.gainFor(track,playback,time,{schedule:true});
      group.el.playbackRate=playback.rate||1;
      if('preservesPitch' in group.el) group.el.preservesPitch=group.el.playbackRate>=.25&&group.el.playbackRate<=4;
      const playerTime=getPlayerAdapter().playerTime(playback.sourceTime,group.url);
      if(group.seekRequest&&!shouldStart&&Math.abs(group.seekRequest.time-playback.sourceTime)<=.12)return;
      if(shouldStart||group.seekRequest||Math.abs(group.el.currentTime-playerTime)>.12){
        const resume=shouldStart||group.seekRequest?.resume||!group.el.paused;
        this.cancelSeek(group);
        const controller=new AbortController(),request={controller,time:playback.sourceTime,resume};group.seekRequest=request;
        const ready=()=>{
          if(group.seekRequest!==request||controller.signal.aborted)return;
          group.seekRequest=null;
          const latest=this.environment();
          if(!group.running||latest.transportMuted()||this.groups.get(group.original)?.get(group.clip)!==group
            ||group.url!==(group.original.currentSrc||group.original.src)||!this.playback(group,latest.timelineTime())
            ||group.tracks.some(track=>!latest.tracks().includes(track))||!group.tracks.some(track=>!track._srcHidden))return;
          if(resume)group.el.play()?.catch?.(()=>{});
        };
        const pending=getPlayerAdapter().seekElement(group.el,playback.sourceTime,{signal:controller.signal});
        if(pending?.then){group.el.pause();pending.then(ready).catch(()=>{if(group.seekRequest===request)group.seekRequest=null;});}
        else ready();
      }
    }catch(_){}
  }
  start(element,time){
    for(const entries of this.groups.values())for(const group of entries.values())if(group.el===element){this.syncGroup(group,true,time);return true;}
    return false;
  }
  sync(time){this.prune(time);for(const entries of this.groups.values())for(const group of entries.values())this.syncGroup(group,false,time);}
  stop(){for(const entries of this.groups.values())for(const group of entries.values()){group.running=false;group.pendingStart=false;this.cancelSeek(group);try{group.el.pause();}catch(_){}}}
  prune(time){
    const tracks=this.environment().tracks();
    for(const [original,entries] of this.groups)for(const [clip,group] of entries){
      if(group.url!==(original.currentSrc||original.src)||group.tracks.some(track=>!tracks.includes(track))||!this.playback(group,time))this.release(original,clip);
    }
  }
  release(original,clip){
    const entries=this.groups.get(original),group=entries?.get(clip);if(!group)return;
    this.cancelSeek(group);
    entries.delete(clip);if(!entries.size)this.groups.delete(original);
    group.running=false;group.pendingStart=false;group.el.removeEventListener('loadedmetadata',group.ready);group.el.removeEventListener('canplay',group.ready);
    try{group.el.pause();group.el.src='';group.el.load?.();}catch(_){}
    try{group.node?.disconnect();group.splitter?.disconnect();}catch(_){}
  }
  clear(){for(const [original,entries] of this.groups)for(const clip of [...entries.keys()])this.release(original,clip);}
}

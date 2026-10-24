// @vitest-environment jsdom
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const adapters=vi.hoisted(()=>({
  Media:{mpvMode:true,displayTime:vi.fn(),inGap:vi.fn(),mpvPresenting:vi.fn(),previewFadeDarkness:vi.fn(),previewComposition:vi.fn(),captureMediaOwnership:vi.fn(()=>()=>true),withPresentedFrame:vi.fn()},
  player:{screenshot:vi.fn(),setImageGuide:vi.fn()},
}));
vi.mock('../src/media.js',()=>({Media:adapters.Media,Wave:{sources:[]}}));
vi.mock('../src/media-player-adapter.js',()=>({getPlayerAdapter:()=>adapters.player}));
vi.mock('../src/subio.js',()=>({toASSFromState:vi.fn()}));
vi.mock('../src/timeline-renderer.js',()=>({drawTimeline:vi.fn(),updatePlayhead:vi.fn()}));
vi.mock('../src/mixer.js',()=>({renderAudioTracks:vi.fn(),clearMeterStrips:vi.fn()}));
vi.mock('../src/subtitles.js',()=>({refreshSelectionUI:vi.fn(),selectCueSingle:vi.fn()}));
vi.mock('../src/history.js',()=>({History:{},recordHistory:vi.fn()}));
vi.mock('../src/ui.js',()=>({showToast:vi.fn(),setMpvWindowVisible:vi.fn(),setStatus:vi.fn()}));

// A tiny software canvas adapter checks the resulting content. It deliberately
// knows nothing about SUB Tool's geometry, presenter selection or fade rules.
const contexts=new WeakMap();
function contextFor(canvas){
  if(contexts.has(canvas)) return contexts.get(canvas);
  let pixels=[],alpha=1,clip=null;
  const stack=[];
  const ensure=()=>{if(pixels.length!==canvas.width*canvas.height*3) pixels=Array(canvas.width*canvas.height*3).fill(0);};
  const paint=(x,y,color)=>{
    ensure();
    if(x<0||y<0||x>=canvas.width||y>=canvas.height) return;
    if(clip&&(x+0.5<clip.x||y+0.5<clip.y||x+0.5>=clip.x+clip.w||y+0.5>=clip.y+clip.h)) return;
    const p=(y*canvas.width+x)*3;
    for(let n=0;n<3;n++) pixels[p+n]=Math.round(color[n]*alpha+pixels[p+n]*(1-alpha));
  };
  const ctx={
    fillStyle:'#000',
    get globalAlpha(){return alpha;},set globalAlpha(v){alpha=v;},
    pixel(x,y){ensure();return pixels.slice((y*canvas.width+x)*3,(y*canvas.width+x)*3+3);},
    fillRect(x,y,w,h){
      const color=({'#000':[0,0,0],'#00f':[0,0,255],'#0f0':[0,255,0]})[this.fillStyle];
      for(let py=Math.max(0,y);py<Math.min(canvas.height,y+h);py++) for(let px=Math.max(0,x);px<Math.min(canvas.width,x+w);px++) paint(px,py,color);
    },
    save(){stack.push({alpha,clip:clip&&{...clip}});},
    restore(){({alpha,clip}=stack.pop());},
    beginPath(){},rect(x,y,w,h){this.nextClip={x,y,w,h};},clip(){clip={...this.nextClip};},
    drawImage(source,...args){
      const sw=source.naturalWidth||source.videoWidth||source.width;
      const sh=source.naturalHeight||source.videoHeight||source.height;
      const [sx,sy,cw,ch,dx,dy,dw,dh]=args.length===8?args:[0,0,sw,sh,...args];
      for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++){
        if(x+0.5<dx||y+0.5<dy||x+0.5>=dx+dw||y+0.5>=dy+dh) continue;
        const px=Math.floor(sx+(x+0.5-dx)*cw/dw),py=Math.floor(sy+(y+0.5-dy)*ch/dh);
        paint(x,y,source.testColor||contextFor(source).pixel(px,py));
      }
    },
  };
  contexts.set(canvas,ctx);return ctx;
}

class CaptureImage{
  naturalWidth=8;naturalHeight=4;
  set src(value){
    this.source=value;
    this.testColor=value==='blob:green'?[0,255,0]:value==='blob:yellow'?[255,255,0]:[255,0,0];
    queueMicrotask(()=>this.onload?.());
  }
}

let State,Seq,imageLayerPlan,capturePreviewFrame,renderImageOverlays,preview,video;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const image=(overrides={})=>({id:'image',type:'image',path:'blob:green',in:0,out:4,offset:0,vtrack:0,natW:8,natH:4,scale:1,posX:0.5,posY:0.5,...overrides});
const pixel=(result,x,y)=>contextFor(result.canvas).pixel(x,y);

beforeAll(async()=>{
  const parsed=new DOMParser().parseFromString(fs.readFileSync(path.join(process.cwd(),'index.html'),'utf8'),'text/html');
  document.body.innerHTML=parsed.body.innerHTML;
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(function(){return contextFor(this);});
  vi.stubGlobal('Image',CaptureImage);
  ({State}=await import('../src/state.js'));
  ({Seq}=await import('../src/sequence.js'));
  ({imageLayerPlan}=await import('../src/image-compositor-engine.js'));
  ({capturePreviewFrame,renderImageOverlays}=await import('../src/video-renderer.js'));
  preview=document.getElementById('previewCanvas');video=document.getElementById('video');
  Object.defineProperties(video,{readyState:{configurable:true,value:2},videoWidth:{configurable:true,value:8},videoHeight:{configurable:true,value:4}});
  video.testColor=[255,0,0];
  const wrap=document.getElementById('videoWrap');
  Object.defineProperties(wrap,{clientWidth:{configurable:true,value:8},clientHeight:{configurable:true,value:4}});
});
beforeEach(()=>{
  vi.clearAllMocks();
  adapters.Media.captureMediaOwnership.mockReturnValue(()=>true);
  adapters.Media.withPresentedFrame.mockImplementation(async (time, capture) => capture({ adapter: adapters.player, isCurrent: () => true }));
  Object.assign(State,{videoWidth:8,videoHeight:4,fps:25,dropFrame:false,clips:[],videoTracks:[{visible:true}],soloVideoTrack:-1});
  adapters.Media.displayTime.mockReturnValue(1);
  adapters.Media.inGap.mockReturnValue(false);
  adapters.Media.mpvPresenting.mockReturnValue(false);
  adapters.Media.previewFadeDarkness.mockReturnValue(0);
  adapters.Media.previewComposition.mockReturnValue(null);
  adapters.player.screenshot.mockResolvedValue({ok:true});
  adapters.player.setImageGuide.mockResolvedValue(undefined);
  preview.width=8;preview.height=8;preview.style.display='none';preview.style.visibility='visible';preview.hidden=false;
  const ctx=contextFor(preview);ctx.fillStyle='#000';ctx.fillRect(0,0,8,8);ctx.fillStyle='#00f';ctx.fillRect(0,2,8,4);
  video.style.visibility='visible';video.style.display='block';
  const layer=document.getElementById('imageLayer');layer.innerHTML='';layer._imageHtml='';
});
afterAll(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it.each(['replacement','same-source-clone','reset'])('image metadata %s respects live source and media lifetime',reason=>{
  const pending=[];
  class DeferredImage{naturalWidth=1920;naturalHeight=1080;set src(value){this.source=value;pending.push(this);}}
  vi.stubGlobal('Image',DeferredImage);
  let owned=true;adapters.Media.captureMediaOwnership.mockReturnValue(()=>owned);
  const url=`blob:metadata-${reason}`;
  State.clips=[image({id:'same-image',path:url,natW:0,natH:0})];renderImageOverlays();
  expect(pending).toHaveLength(1);
  const replacement=image({id:'same-image',path:reason==='replacement'?'blob:new-portrait':url,natW:reason==='replacement'?600:0,natH:reason==='replacement'?1200:0});
  State.clips=[replacement];
  if(reason==='reset')owned=false;
  pending[0].onload();
  expect([replacement.natW,replacement.natH]).toEqual(reason==='replacement'?[600,1200]:reason==='same-source-clone'?[1920,1080]:[0,0]);
  vi.stubGlobal('Image',CaptureImage);
});

it('a completed image dimension cache cannot cross a media epoch when a same URL is reloaded',()=>{
  const pending=[];let generation=0;
  class DeferredImage{naturalWidth=1920;naturalHeight=1080;set src(value){this.source=value;pending.push(this);}}
  vi.stubGlobal('Image',DeferredImage);
  adapters.Media.captureMediaOwnership.mockImplementation(()=>{const stamp=generation;return()=>stamp===generation;});
  const clip=image({path:'blob:reloaded-image-dimensions',natW:0,natH:0});
  State.clips=[clip];renderImageOverlays();pending[0].onload();
  expect([clip.natW,clip.natH]).toEqual([1920,1080]);
  generation++;
  const replacement={...clip,natW:0,natH:0};State.clips=[replacement];renderImageOverlays();
  expect([replacement.natW,replacement.natH]).toEqual([0,0]);expect(pending).toHaveLength(2);
  pending[1].naturalWidth=600;pending[1].naturalHeight=1200;pending[1].onload();
  expect([replacement.natW,replacement.natH]).toEqual([600,1200]);
  vi.stubGlobal('Image',CaptureImage);
});

describe('capturePreviewFrame uses the visible presenter and frozen timeline image plan',()=>{
  it.each(['layer plan','DOM overlay','captured pixels'])('adjacent frame arithmetic keeps the incoming image visible in %s',async caller=>{
    const previous=image({id:'previous',path:'blob:red',in:29/30,out:33/30});
    const incoming=image({id:'incoming',offset:Seq.clipEnd(previous)});
    State.clips=[previous,incoming];
    const time=4/30;
    expect(time).toBeLessThan(incoming.offset);
    expect(Seq.clipsAt(time)).toEqual([incoming]);
    expect(Seq.clipsAt(Seq.clipEnd(incoming))).toEqual([]);
    adapters.Media.displayTime.mockReturnValue(time);
    if(caller==='layer plan'){
      expect(imageLayerPlan({stageW:8,stageH:4,track:State.videoTracks[0],clip:Seq.clipsAt(time)[0],natW:8,natH:4,time}).alpha).toBe(1);
    }else if(caller==='DOM overlay'){
      renderImageOverlays();
      expect(getComputedStyle(document.querySelector('#imageLayer .img-wrap[data-id="incoming"]')).opacity).toBe('1');
    }else{
      const result=await capturePreviewFrame();
      expect(pixel(result,4,2)).toEqual([0,255,0]);
    }
  });

  it('captures the visible WebCodecs project rectangle while mpv is loaded but no longer presenting',async()=>{
    preview.style.display='block';
    const readBase64=vi.fn();
    const result=await capturePreviewFrame({nativePath:'temp.jpg',readBase64});
    expect(result.presenter).toBe('webcodecs');
    expect(pixel(result,0,0)).toEqual([0,0,255]);
    expect(pixel(result,7,3)).toEqual([0,0,255]);
    expect(adapters.player.screenshot).not.toHaveBeenCalled();expect(readBase64).not.toHaveBeenCalled();
  });

  it('composites separate image layers over WebCodecs video exactly once',async()=>{
    adapters.Media.previewFadeDarkness.mockReturnValue(0.5);
    preview.style.display='block';State.videoTracks=[{visible:true,opacity:0.5}];State.clips=[image()];
    const result=await capturePreviewFrame();
    expect(result.presenter).toBe('webcodecs');
    expect(pixel(result,4,2)).toEqual([0,128,128]);
  });

  it('uses the held mixed canvas time and pixels without repainting changed images or opacity',async()=>{
    preview.style.display='block';
    const ctx=contextFor(preview);ctx.globalAlpha=0.5;ctx.fillStyle='#0f0';ctx.fillRect(0,2,8,4);ctx.globalAlpha=1;
    const composition=Object.freeze({time:1,imagesComposited:true,imageIds:Object.freeze(['old-image'])});
    adapters.Media.previewComposition.mockReturnValue(composition);
    adapters.Media.displayTime.mockReturnValue(3);
    adapters.Media.inGap.mockReturnValue(true);
    State.clips=[image({id:'new-image',path:'blob:yellow',vtrack:1})];
    State.videoTracks=[{visible:true},{visible:true,opacity:1,scale:0.25}];
    const result=await capturePreviewFrame();
    expect(result).toMatchObject({presenter:'webcodecs',time:1});
    expect(pixel(result,4,2)).toEqual([0,128,128]);
    expect(adapters.player.screenshot).not.toHaveBeenCalled();
  });

  it('captures the retained video canvas while a newly mixed image waits for decoding',async()=>{
    preview.style.display='block';
    adapters.Media.previewComposition.mockReturnValue(Object.freeze({time:1,width:8,height:4,imagesComposited:false,imageIds:Object.freeze([])}));
    State.clips=[image(),{id:'upper',type:'video',in:0,out:4,offset:0,vtrack:1}];
    State.videoTracks=[{visible:true},{visible:true,scale:0.5,posX:1,posY:0}];
    State.videoWidth=16;State.videoHeight=16;
    const result=await capturePreviewFrame();
    expect(result.canvas.width).toBe(8);expect(result.canvas.height).toBe(4);
    expect(result.time).toBe(1);
    expect(pixel(result,1,1)).toEqual([0,0,255]);
  });

  it.each(['html5','mpv'])('places a lower image below a half opaque PiP video in %s capture',async presenter=>{
    State.videoTracks=[{visible:true},{visible:true,scale:0.5,posX:1,posY:0,opacity:0.5}];
    State.clips=[image({vtrack:0}),{id:'video',type:'video',in:0,out:4,offset:0,vtrack:1,natW:8,natH:4}];
    if(presenter==='mpv') adapters.Media.mpvPresenting.mockReturnValue(true);
    const result=await capturePreviewFrame({nativePath:'temp.jpg',readBase64:async()=> 'native-red'});
    expect(pixel(result,1,1)).toEqual([0,255,0]);
    expect(pixel(result,6,0)).toEqual([128,128,0]);
    expect(pixel(result,6,3)).toEqual([0,255,0]);
  });

  it('captures an image-only timeline in a video gap with track PiP clipping and combined fade/opacity',async()=>{
    adapters.Media.inGap.mockReturnValue(true);adapters.Media.mpvPresenting.mockReturnValue(true);
    State.videoTracks=[{visible:true,scale:0.5,posX:1,posY:0,opacity:0.5}];
    State.clips=[image({scale:2,fadeIn:2})];
    const result=await capturePreviewFrame();
    expect(result.presenter).toBe('black');
    expect(pixel(result,3,0)).toEqual([0,0,0]);
    expect(pixel(result,4,0)).toEqual([0,64,0]);
    expect(pixel(result,7,1)).toEqual([0,64,0]);
    expect(pixel(result,7,2)).toEqual([0,0,0]);
    expect(adapters.player.screenshot).not.toHaveBeenCalled();
  });

  it('honors computed visibility before falling back to the visible HTML video',async()=>{
    preview.style.display='block';preview.style.visibility='hidden';
    const result=await capturePreviewFrame();
    expect(result.presenter).toBe('html5');expect(pixel(result,4,2)).toEqual([255,0,0]);
  });

  it('captures HTML video fading below the image layer without dimming that image layer',async()=>{
    adapters.Media.previewFadeDarkness.mockReturnValue(0.5);
    State.videoTracks=[{visible:true},{visible:true,scale:0.5,posX:1,posY:0,opacity:0.5}];State.clips=[image({vtrack:1})];
    const result=await capturePreviewFrame();
    expect(result.presenter).toBe('html5');
    // The video is half red under the previewFade black mask; the separate green
    // image then covers half of that result, rather than receiving a second fade.
    expect(pixel(result,3,0)).toEqual([128,0,0]);
    expect(pixel(result,4,0)).toEqual([64,128,0]);
  });

  it('accepts a canvas whose hidden attribute is overridden by an author display rule',async()=>{
    const style=document.createElement('style');style.textContent='#previewCanvas[hidden]{display:block!important}';document.head.appendChild(style);
    try{
      preview.hidden=true;
      const result=await capturePreviewFrame();
      expect(result.presenter).toBe('webcodecs');expect(pixel(result,4,2)).toEqual([0,0,255]);
    }finally{style.remove();}
  });

  it('omits hidden tracks and images outside their timeline duration',async()=>{
    adapters.Media.inGap.mockReturnValue(true);
    State.videoTracks=[{visible:false},{visible:true}];
    State.clips=[image(),image({id:'future',vtrack:1,offset:3})];
    const result=await capturePreviewFrame();
    expect(pixel(result,4,2)).toEqual([0,0,0]);
  });

  it.each(['negative acknowledgement','rejection'])('does not read an old native image after %s',async(kind)=>{
    adapters.Media.mpvPresenting.mockReturnValue(true);
    if(kind==='rejection') adapters.player.screenshot.mockRejectedValue(new Error('mpv disconnected'));
    else adapters.player.screenshot.mockResolvedValue({ok:false});
    const readBase64=vi.fn().mockResolvedValue('old-image');
    await expect(capturePreviewFrame({nativePath:'temp.jpg',readBase64})).rejects.toThrow();
    expect(readBase64).not.toHaveBeenCalled();
  });

  it('captures native pixels only inside the held, confirmed timeline frame',async()=>{
    adapters.Media.mpvPresenting.mockReturnValue(true);
    const ready=deferred();
    adapters.Media.withPresentedFrame.mockImplementation(async (time,capture)=>{
      await ready.promise;
      return capture({adapter:adapters.player,isCurrent:()=>true});
    });
    const readBase64=vi.fn().mockResolvedValue('native-red');
    const pending=capturePreviewFrame({nativePath:'temp.jpg',readBase64});
    expect(adapters.Media.withPresentedFrame).toHaveBeenCalledWith(1,expect.any(Function));
    expect(adapters.player.screenshot).not.toHaveBeenCalled();
    ready.resolve();
    const snapshot=await pending;
    expect(snapshot.time).toBe(1);
    expect(pixel(snapshot,0,0)).toEqual([255,0,0]);
  });

  it('rejects native pixels after a newer seek or source owns the pending capture',async()=>{
    adapters.Media.mpvPresenting.mockReturnValue(true);
    const acknowledgement=deferred();
    adapters.player.screenshot.mockReturnValue(acknowledgement.promise);
    let owned=true;
    adapters.Media.withPresentedFrame.mockImplementation((time,capture)=>capture({adapter:adapters.player,isCurrent:()=>owned}));
    const readBase64=vi.fn().mockResolvedValue('native-red');
    const pending=capturePreviewFrame({nativePath:'temp.jpg',readBase64});
    owned=false;acknowledgement.resolve({ok:true});
    await expect(pending).rejects.toMatchObject({name:'AbortError'});
    expect(readBase64).not.toHaveBeenCalled();
  });

  it('keeps the original frame time, FPS, image source, PiP geometry and opacity while native acknowledgement is pending',async()=>{
    adapters.Media.mpvPresenting.mockReturnValue(true);
    adapters.Media.previewFadeDarkness.mockReturnValue(0.5);
    const ack=deferred();adapters.player.screenshot.mockReturnValue(ack.promise);
    State.videoTracks=[{visible:true,scale:0.5,posX:1,posY:0,opacity:0.5}];
    const original=image({scale:2,fadeIn:2});State.clips=[original];State.fps=29.97;State.dropFrame=true;
    const readBase64=vi.fn().mockResolvedValue('native-red');
    const pending=capturePreviewFrame({nativePath:'temp.jpg',readBase64});
    expect(readBase64).not.toHaveBeenCalled();
    adapters.Media.displayTime.mockReturnValue(99);State.fps=60;State.dropFrame=false;
    Object.assign(original,{path:'blob:yellow',scale:0.25,offset:20});
    Object.assign(State.videoTracks[0],{opacity:1,scale:1,posX:0.5,visible:false});
    ack.resolve({ok:true});const result=await pending;
    expect(result).toMatchObject({time:1,fps:29.97,dropFrame:true,presenter:'mpv'});
    expect(pixel(result,3,0)).toEqual([255,0,0]);
    expect(pixel(result,4,0)).toEqual([191,64,0]);
    expect(pixel(result,7,2)).toEqual([255,0,0]);
    expect(readBase64).toHaveBeenCalledOnce();expect(readBase64).toHaveBeenCalledWith('temp.jpg');
  });
});

describe('image preview DOM clipping',()=>{
  it('uses anonymous CORS for both the image DOM and the independently loaded screenshot image',async()=>{
    const loads=[];
    class CorsImage extends CaptureImage{
      set src(value){loads.push({url:value,crossOrigin:this.crossOrigin});super.src=value;}
    }
    vi.stubGlobal('Image',CorsImage);
    try{
      State.clips=[image({path:'subtool-local://resource/image-token'})];
      renderImageOverlays();
      expect(document.querySelector('#imageLayer img').crossOrigin).toBe('anonymous');
      await capturePreviewFrame();
      expect(loads).toContainEqual({url:'subtool-local://resource/image-token',crossOrigin:'anonymous'});
    }finally{vi.stubGlobal('Image',CaptureImage);}
  });

  it('clips an oversized image to its containing PiP track',()=>{
    State.videoTracks=[{visible:true,scale:0.5,posX:1,posY:0,opacity:0.5}];State.clips=[image({scale:2,fadeIn:2})];
    renderImageOverlays();
    const wrap=document.querySelector('#imageLayer .img-wrap');const img=wrap.querySelector('img');
    expect(wrap.style.opacity).toBe('0.25');
    expect(img.style.clipPath).toBe('inset(1.00px 2.00px 1.00px 2.00px)');
    expect(wrap.style.left).toBe('2px');expect(wrap.style.top).toBe('-1px');
  });

  it('leaves image hit wrappers and resize handles while a held mixed canvas owns the bitmap',()=>{
    adapters.Media.previewComposition.mockReturnValue(Object.freeze({time:1,imagesComposited:true,imageIds:Object.freeze(['previous'])}));
    adapters.Media.displayTime.mockReturnValue(3);
    State.clips=[image({id:'changed',vtrack:1})];State.videoTracks=[{visible:true},{visible:true}];
    renderImageOverlays();
    const wrap=document.querySelector('#imageLayer .img-wrap');
    expect(wrap.dataset.id).toBe('changed');
    expect(wrap.querySelector('img').style.visibility).toBe('hidden');
    expect(wrap.querySelectorAll('.resize-handle')).toHaveLength(4);
  });

  it('does not let lower images cover native video while the shared compositor is preparing',()=>{
    adapters.Media.mpvPresenting.mockReturnValue(true);
    State.videoTracks=[{visible:true},{visible:true}];
    State.clips=[image({vtrack:0}),{id:'upper',type:'video',in:0,out:4,offset:0,vtrack:1}];
    renderImageOverlays();
    expect(document.querySelector('#imageLayer img').style.visibility).toBe('hidden');
    expect(adapters.player.setImageGuide).toHaveBeenLastCalledWith(expect.objectContaining({html:expect.stringContaining('visibility:hidden')}));
  });
});

it.each(['webcodecs','html5','mpv'])('keeps a lower image below an opaque video in %s capture',async presenter=>{
  State.videoTracks=[{visible:true},{visible:true}];
  State.clips=[image({vtrack:0}),{id:'upper',type:'video',in:0,out:4,offset:0,vtrack:1}];
  if(presenter==='webcodecs') preview.style.display='block';
  if(presenter==='mpv') adapters.Media.mpvPresenting.mockReturnValue(true);
  const result=await capturePreviewFrame({nativePath:'temp.jpg',readBase64:async()=> 'native-red'});
  expect(pixel(result,4,2)).toEqual(presenter==='webcodecs'?[0,0,255]:[255,0,0]);
});

it('preserves the lower image outside the upper video-only canvas PiP rectangle',async()=>{
  preview.style.display='block';
  const ctx=contextFor(preview);ctx.fillStyle='#000';ctx.fillRect(0,0,8,8);ctx.fillStyle='#00f';ctx.fillRect(4,2,4,2);
  State.videoTracks=[{visible:true},{visible:true,scale:0.5,posX:1,posY:0}];
  State.clips=[image({vtrack:0}),{id:'upper',type:'video',in:0,out:4,offset:0,vtrack:1}];
  const result=await capturePreviewFrame();
  expect(pixel(result,1,1)).toEqual([0,255,0]);
  expect(pixel(result,6,0)).toEqual([0,0,255]);
});

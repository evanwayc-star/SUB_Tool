/* global window, document, Worker, AudioContext, XMLHttpRequest */
/* node scripts/acceptance/verify-recognition-review.js after npm run build.
 * Open the production web entry in an isolated hidden Electron renderer.
 * Only the provider's response is substituted; no request can reach a service.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { ROOT, ELECTRON, verifiedCleanup } = require('./cdp-electron-harness');

if (!process.versions.electron) {
  const profile=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-review-ui-'));
  try {
    const result=spawnSync(ELECTRON,[__filename,'--user-data-dir='+profile,'--disable-background-timer-throttling'],{windowsHide:true,stdio:'inherit',timeout:90000});
    if(result.error)throw result.error;
    process.exitCode=result.status??1;
  } finally { verifiedCleanup(profile,'subtool-review-ui-'); }
} else {
  const { app, BrowserWindow }=require('electron');
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{backgroundThrottling:false,offscreen:true}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,done)=>done({cancel:true}));
    await win.loadFile(path.join(ROOT,'dist','index.html'));
    const read=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
    const exercise=await read(async()=>{
      const {State,History}=window.SUB;
      const $=id=>document.getElementById(id),wait=async fn=>{
        const end=performance.now()+20000;
        while(!fn()){if(performance.now()>end)throw Error([$('modalTitle').textContent,$('asrTrialStatus')?.textContent,$('asrStatus')?.textContent,$('modalBody').innerText.slice(-600)].join(' | '));await new Promise(r=>setTimeout(r,15));}
      };
      const switchValue=(id,value)=>{const el=$(id);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));};
      const pcm=new Float32Array(35*16000);
      for(let i=0;i<pcm.length;i++)pcm[i]=.2*Math.sin(i/7);
      const buffer={sampleRate:16000,numberOfChannels:1,length:pcm.length,duration:35,getChannelData:()=>pcm};
      const clip={id:'review-fixture',name:'對白.wav',in:0,out:35,dur:35,offset:0,audioSourceId:'source',audioBuffer:buffer};
      State.clips=[clip];State.cues=[];State.duration=35;State.recognitionTerms=[];
      const project=()=>JSON.stringify([State.cues,State.tracks,State.recognitionTerms,History.stack.length]);
      const baseline=project(),calls=[];let long=false;
      const lines=Array.from({length:3000},(_,i)=>'token'+i);
      const nativeWorker=Worker,workerSamples=[];
      let cancelOnProgress=false,cancelSent=0,cancelLatency=null,workerStart=0,workerEnd=0;
      const longTasks=[];
      const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(task=>({start:task.startTime,duration:task.duration}))));
      observer.observe({type:'longtask',buffered:false});
      window.Worker=class extends nativeWorker {
        constructor(...args){super(...args);this.addEventListener('message',event=>{
          if(Number.isFinite(event.data.progress)){
            workerSamples.push(event.data.progress);
            if(cancelOnProgress){
              cancelOnProgress=false;cancelSent=performance.now();
              $('modalFoot').querySelector('button').click();
            }
          }else if(event.data.result)workerEnd=performance.now();
        });}
        postMessage(...args){workerStart=performance.now();return super.postMessage(...args);}
        terminate(){if(cancelSent){cancelLatency=performance.now()-cancelSent;cancelSent=0;}return super.terminate();}
      };
      window.fetch=async(url,options)=>{
        if(!String(url).includes('api.groq.com'))throw Error('unexpected fetch');
        const wav=options.body.get('file'),bytes=await wav.arrayBuffer(),view=new DataView(bytes);
        const duration=(view.getUint32(40,true)/2)/view.getUint32(24,true);calls.push(duration);
        const chunks=long?lines.map((text,i)=>({text,start:i/100,end:(i+.8)/100})):
          [{text:'候選甲',start:1,end:2},{text:'候選乙',start:3,end:4}];
        return Response.json({text:chunks.map(s=>s.text).join(' '),segments:chunks,words:chunks.map(s=>({...s,word:s.text}))});
      };
      const open=async()=>{$('asrMonitorBtn').click();await wait(()=>typeof $('asrListen')?.onclick==='function');};
      await open();switchValue('asrProvider','groq');$('asrApiKey').value='test-only';
      switchValue('asrResultMode','trial');$('asrProjectTerms').value='候選甲';
      $('asrListen').closest('details').open=true;
      $('asrListen').click();await wait(()=>!$('asrTrialAudio').hidden);
      const audio=$('asrTrialAudio'),context=new AudioContext({sampleRate:16000});
      const audition=await context.decodeAudioData(await XMLHttpBytes(audio.src));
      await context.close();
      async function XMLHttpBytes(url){return new Promise((resolve,reject)=>{const req=new XMLHttpRequest();req.open('GET',url);req.responseType='arraybuffer';req.onload=()=>resolve(req.response);req.onerror=reject;req.send();});}
      const callsBefore=calls.length;
      $('modalFoot').querySelector('button.primary').click();await wait(()=>$('recognitionReviewText'));
      const trialUnchanged=project()===baseline,original=$('recognitionReviewOriginal').textContent;
      $('recognitionReviewText').value='人工修改';$('recognitionReviewText').dispatchEvent(new Event('input'));
      $('recognitionReviewNext').click();$('recognitionReviewKeep').click();$('recognitionReviewBack').click();
      const editSurvived=$('recognitionReviewText').value;
      $('modalFoot').querySelector('button.primary').click();
      const applied=State.cues.map(({text,recognition})=>({text,recognition}));
      long=true;await open();switchValue('asrProvider','groq');$('asrApiKey').value='test-only';
      $('asrModeAlign').click();$('asrTranscript').value=lines.join('\n');switchValue('asrResultMode','review');
      const beforeCancel=project();cancelOnProgress=true;
      $('modalFoot').querySelector('button.primary').click();
      await wait(()=>cancelLatency!==null);
      if(project()!==beforeCancel)throw Error('取消仍改動專案');
      await open();
      $('asrModeAlign').click();$('asrTranscript').value=lines.join('\n');switchValue('asrResultMode','review');workerSamples.length=0;
      let ticks=0,maxGap=0,last=0,endAt=0;
      const pulse=setInterval(()=>{if(!workerSamples.length)return;const time=performance.now();if(last)maxGap=Math.max(maxGap,time-last);last=time;ticks++;},5);
      $('modalFoot').querySelector('button.primary').click();
      await wait(()=>$('recognitionReviewIndex')?.textContent.includes('3000'));endAt=workerSamples.at(-1);clearInterval(pulse);
      const lineCount=$('recognitionReviewIndex').textContent;
      for(let i=0;i<lines.length;i++){
        if($('recognitionReviewText').value!==lines[i])throw Error('原稿對位錯行 '+i);
        if(i+1<lines.length)$('recognitionReviewNext').click();
        if(i%200===0)await new Promise(r=>setTimeout(r,0));
      }
      const lastLine=$('recognitionReviewIndex').textContent;
      const matchingLongTasks=longTasks.filter(task=>task.start>=workerStart && task.start<workerEnd);
      observer.disconnect();
      return {callsBefore,seconds:audition.duration,trialUnchanged,original,editSurvived,applied,calls,lineCount,lastLine,cancelLatency,
        workerProgressEvents:workerSamples.length,endAt,ticks,maxGap,workerWallMs:workerEnd-workerStart,matchingLongTasks};
    });
    assert.equal(exercise.callsBefore,0);assert.equal(exercise.seconds,20);assert.equal(exercise.calls[0],20);
    assert.ok(exercise.trialUnchanged);assert.equal(exercise.editSurvived,'人工修改');
    assert.equal(exercise.applied.length,1);assert.equal(exercise.applied[0].recognition.originalText,exercise.original);
    assert.ok(exercise.workerProgressEvents>0);assert.ok(exercise.ticks>0);assert.ok(exercise.cancelLatency<200);
    const screenshot=path.join(os.tmpdir(),'subtool-recognition-review.png');
    await new Promise(r=>setTimeout(r,300));
    fs.writeFileSync(screenshot,(await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({...exercise,screenshot},null,2));app.exit(0);
  }).catch(error=>{console.error(error);app.exit(1);});
}

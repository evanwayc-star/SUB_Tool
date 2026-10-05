/* Windows 真機驗收：npm run build && node scripts/acceptance/verify-vocal-waveform.js
   安裝版：設定 SUBTOOL_ACCEPTANCE_EXE 為正式安裝的 SUB Tool.exe 後執行。
   以本機 TTS＋配樂 tone 建立無私人內容 fixture；實際下載固定模型並在 Worker 推論。
   使用隔離 profile，不修改正式設定；結果與截圖保存在系統 temp。 */
const fs=require('fs');
const path=require('path');
const os=require('os');
const {execFileSync,spawn}=require('child_process');
const {ROOT,ELECTRON,delay,reservePort,getJSON,waitFor,CdpClient,trackElectron,stopElectron,dispatchClick}
  =require('./cdp-electron-harness.js');
const PACKAGED_EXE=process.env.SUBTOOL_ACCEPTANCE_EXE?path.resolve(process.env.SUBTOOL_ACCEPTANCE_EXE):null;

function fixture(directory){
  const speech=path.join(directory,'speech.wav');
  const script=`Add-Type -AssemblyName System.Speech
$voice=New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice.SetOutputToWaveFile('${speech.replaceAll("'","''")}')
$voice.Speak('This is a test of clear speech. Please add subtitles at the correct time.')
$voice.Dispose()`;
  execFileSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,stdio:['ignore','pipe','pipe']});
  const media=path.join(directory,'speech-music.mkv');
  execFileSync(path.join(ROOT,'electron','ffmpeg','ffmpeg.exe'),[
    '-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=black:s=640x360:r=25:d=15',
    '-i',speech,'-f','lavfi','-i','sine=frequency=330:sample_rate=44100:duration=15',
    '-f','lavfi','-i','sine=frequency=660:sample_rate=44100:duration=15',
    '-filter_complex','[1:a]adelay=3000|3000,apad=whole_dur=15,volume=0.9[v];[2:a]volume=1.4[m1];[3:a]volume=0.7[m2];[v][m1][m2]amix=inputs=3:duration=longest:normalize=0[out]',
    '-map','0:v','-map','[out]','-ac','2','-ar','44100','-c:v','libx264','-preset','ultrafast','-crf','28','-c:a','pcm_s16le','-t','15',media
  ],{windowsHide:true,timeout:30000});
  const project={app:'SUB Tool',version:3,media:{name:path.basename(media),size:fs.statSync(media).size,path:media},
    duration:15,fps:25,tracks:[],cues:[],notes:[],clips:[{id:'vocal-acceptance',name:path.basename(media),path:media,
      dur:15,in:0,out:15,offset:0,vtrack:0,primary:true}],playhead:0};
  const projectPath=path.join(directory,'vocals.subtool');
  fs.writeFileSync(projectPath,Buffer.concat([Buffer.from([255,254]),Buffer.from(JSON.stringify(project),'utf16le')]));
  return projectPath;
}

const snapshot='JSON.stringify({clips:SUB.State.clips,audio:SUB.State.audioProject,active:SUB.Media.activeSource,history:SUB.History.committedSnapshot()})';
async function clickToggle(client){
  const rect=await client.evaluate(`(()=>{const r=document.querySelector('.audio-vocal-toggle').getBoundingClientRect();
    return {left:r.left,top:r.top,width:r.width,height:r.height}})()`);
  await dispatchClick(client,rect);
}

async function connectWindow(port){
  const target=await waitFor(async()=> (await getJSON(`http://127.0.0.1:${port}/json/list`)).find(item=>item.type==='page'&&item.title==='SUB TOOL'),'主視窗',30000);
  const client=new CdpClient(target.webSocketDebuggerUrl,{timeoutMs:30000});
  await client.connect();await client.send('Runtime.enable');await client.send('Page.bringToFront');
  return client;
}

async function closeWindow(client,child){
  await client.evaluate('setTimeout(()=>{void window.subtool.closeApp()},0);true');
  await waitFor(()=>child.exitCode!==null||child.signalCode!==null,'正常關閉程式',20000);
  client.close();await stopElectron(child);
}

(async()=>{
  if(process.platform!=='win32')throw new Error('此驗收使用 Windows System.Speech 與原生 FFmpeg');
  if(!fs.existsSync(path.join(ROOT,'dist','index.html')))throw new Error('請先執行 npm run build');
  const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-vocal-acceptance-'));
  const project=fixture(directory),profile=path.join(directory,'profile');
  fs.mkdirSync(profile);
  const port=await reservePort(),log=fs.openSync(path.join(directory,'electron.log'),'w');
  const launch=()=>trackElectron(spawn(PACKAGED_EXE||ELECTRON,[...(!PACKAGED_EXE?['.']:[]),project,`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,
    '--subtool-transport-acceptance','--no-sandbox','--disable-background-timer-throttling',
    '--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'],
    {cwd:ROOT,windowsHide:true,stdio:['ignore','ignore',log]}));
  let child=launch();
  let client;
  try{
    client=await connectWindow(port);
    const version=await waitFor(()=>client.evaluate("document.querySelector('#appVersion')?.textContent"),'App 內版本標記',30000);
    if(version!=='v'+require(path.join(ROOT,'package.json')).version)throw new Error('App 內版本不符：'+version);
    await waitFor(()=>client.evaluate(`Boolean(window.SUB?.State.clips.length&&SUB.Media.tracks.length&&
      SUB.Wave.getSourceWaveform(SUB.State.clips[0]).peaks&&document.querySelector('.audio-vocal-toggle'))`),'母素材與原音波形',60000);
    await delay(3000);
    const before=await client.evaluate(snapshot),started=Date.now();
    await client.evaluate('window.__originalVocalAcceptancePeaks=SUB.Wave.getSourceWaveform(SUB.State.clips[0]).peaks');
    await clickToggle(client);
    await waitFor(()=>client.evaluate(`Boolean(SUB.Wave._sourceState(SUB.State.clips[0]).vocals.loading)`),'開始人聲分析',10000);
    const first=await waitFor(()=>client.evaluate(`(()=>{const s=SUB.Wave._sourceState(SUB.State.clips[0]);
      return s.vocals.error?{error:s.vocals.error.message}:s.vocals.peaks||s.vocals.percent>0?{pending:!!s.vocals.loading}:null})()`),'可取消的真模型推論',600000);
    if(first.error)throw new Error(first.error);
    const pendingOriginal=await client.evaluate(`SUB.Wave.getSourceWaveSelection(SUB.State.clips[0])==='mix'&&
      SUB.Wave.getSourceWaveform(SUB.State.clips[0]).peaks===window.__originalVocalAcceptancePeaks`);
    if(!first.pending||!pendingOriginal)throw new Error('分析期間未保留原音波形');
    // The real cancel button must restore MIX and permit an immediate retry.
    await clickToggle(client);
    if(await client.evaluate(`SUB.Wave.getSourceWaveSelection(SUB.State.clips[0])`)!=='mix')throw new Error('取消後未恢復原音');
    await clickToggle(client);
    let lastLabel='';
    const completion=await waitFor(async()=>{
      const state=await client.evaluate(`(()=>{const c=SUB.State.clips[0],s=SUB.Wave._sourceState(c);return {
        selection:s.selection,pending:!!s.vocals.loading,progress:s.vocals.percent,label:s.vocals.label,
        error:s.vocals.error?.message,ready:!!s.vocals.peaks}})()`);
      if(state.label!==lastLabel){lastLabel=state.label;console.log(state.progress+'% '+lastLabel);}
      return state.error?{error:state.error}:state.ready&&state.selection==='vocals'?{done:true}:null;
    },'真正人聲模型推論',600000);
    if(completion.error)throw new Error(completion.error);
    const content=await client.evaluate(`(()=>{const c=SUB.State.clips[0],s=SUB.Wave._sourceState(c);
      const rms=(p,a,b)=>{let sum=0,n=0;for(let i=a*200;i<b*200;i++){sum+=p[i]*p[i];n++;}return Math.sqrt(sum/n)};
      return {length:s.vocals.peaks.length,musicOriginal:rms(s.mix.peaks,0,2),musicVocals:rms(s.vocals.peaks,0,2),
        speechOriginal:rms(s.mix.peaks,3,8),speechVocals:rms(s.vocals.peaks,3,8),
        firstSpeechSeconds:Array.from(s.vocals.peaks).findIndex(value=>Math.abs(value)>.01)/200}})()`);
    const after=await client.evaluate(snapshot);
    if(before!==after)throw new Error('波形切換變更了專案、監聽來源或 History');
    if(content.length!==3000||content.musicOriginal<.05||content.musicVocals>content.musicOriginal*.1||content.speechVocals<.01||
      content.firstSpeechSeconds<2.8||content.firstSpeechSeconds>3.4)throw new Error('人聲內容或時間對齊不正確：'+JSON.stringify(content));
    await client.send('Page.bringToFront');
    await client.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const screenshot=await client.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(directory,'vocal-waveform.png'),Buffer.from(screenshot.data,'base64'));
    // Source in/offset remain independent of the full-source peak indices.
    await client.evaluate(`(()=>{const c=SUB.State.clips[0];c.in=2;c.out=12;c.offset=5;SUB.drawTimeline();return true})()`);
    const cache=await client.evaluate(`(()=>{window.__vocalAcceptancePeaks=SUB.Wave.getSourceWaveform(SUB.State.clips[0]).peaks;
      return window.__vocalAcceptancePeaks.length})()`);
    await clickToggle(client);await clickToggle(client);
    if(!await client.evaluate(`SUB.Wave.getSourceWaveform(SUB.State.clips[0]).peaks===window.__vocalAcceptancePeaks`))throw new Error('重新切換未使用完成的來源快取');
    const analysisSeconds=(Date.now()-started)/1000;
    // A fresh renderer/process and the same profile must restore stored peaks without inference.
    const persistedPeaks=await client.evaluate('Array.from(SUB.Wave.getSourceWaveform(SUB.State.clips[0]).peaks)');
    await closeWindow(client,child);client=null;child=null;
    const reopened=Date.now();child=launch();client=await connectWindow(port);
    await waitFor(()=>client.evaluate(`Boolean(window.SUB?.State.clips.length&&
      SUB.Wave.getSourceWaveSelection(SUB.State.clips[0])==='vocals'&&
      SUB.Wave.getSourceWaveform(SUB.State.clips[0]).peaks)`),'重開後恢復人聲快取',60000);
    const restored=await client.evaluate(`(()=>{const s=SUB.Wave._sourceState(SUB.State.clips[0]);return {
      peaks:Array.from(s.vocals.peaks),pending:!!s.vocals.loading,label:s.vocals.label}})()`);
    if(restored.pending||JSON.stringify(restored.peaks)!==JSON.stringify(persistedPeaks)||!restored.label.includes('快取'))
      throw new Error('重開後未直接使用完整人聲快取');
    const restoreSeconds=(Date.now()-reopened)/1000;
    await waitFor(()=>client.evaluate(`Boolean(document.querySelector('.audio-vocal-toggle'))`),'重開後列頭按鈕',10000);
    await clickToggle(client);
    await closeWindow(client,child);client=null;child=null;
    child=launch();client=await connectWindow(port);
    await waitFor(()=>client.evaluate(`Boolean(window.SUB?.State.clips.length&&SUB.Media.tracks.length&&
      SUB.Wave.getSourceWaveform(SUB.State.clips[0]).peaks)`),'原音選擇重開',60000);
    await delay(1200);
    if(await client.evaluate('SUB.Wave.getSourceWaveSelection(SUB.State.clips[0])')!=='mix')throw new Error('重開後未保留明確的原音選擇');
    const result={...content,version,executable:PACKAGED_EXE||ELECTRON,seconds:analysisSeconds,unchanged:true,
      cacheLength:cache,cancelledDuringInference:first.pending,pendingOriginal,persistentCacheRestored:true,
      restoreSeconds,restoredLabel:restored.label,originalSelectionRestored:true};
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));
    console.log('PASS '+JSON.stringify(result));console.log('驗收檔案：'+directory);
  }finally{client?.close();if(child)await stopElectron(child);fs.closeSync(log);}
})().catch(error=>{console.error(error);process.exitCode=1;});

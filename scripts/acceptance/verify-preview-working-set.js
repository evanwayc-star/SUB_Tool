/* Real Electron/mpv check for WebCodecs prewarm and source eviction.
   Usage: node scripts/acceptance/verify-preview-working-set.js <short-mp4> */
'use strict';

const fs=require('fs');
const os=require('os');
const path=require('path');
const {spawn,execFileSync}=require('child_process');
const {ROOT,ELECTRON,delay,reservePort,getJSON,waitFor,CdpClient,verifiedCleanup}=require('./cdp-electron-harness.js');
const PACKAGED_EXE=process.env.SUBTOOL_ACCEPTANCE_EXE ? path.resolve(process.env.SUBTOOL_ACCEPTANCE_EXE) : null;

async function main(){
  const mediaPath=path.resolve(process.argv[2]||'');
  if(!fs.existsSync(mediaPath)) throw new Error('請提供一支可讀取的短 MP4');
  const profile=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-preview-cdp-'));
  const temp=path.join(profile,'temp'); fs.mkdirSync(temp);
  const project=path.join(profile,'preview-acceptance.subtool');
  const data={app:'SUB Tool',version:3,media:{name:path.basename(mediaPath),size:fs.statSync(mediaPath).size,path:mediaPath},
    duration:20,fps:24,tracks:[],cues:[],notes:[],clips:[{id:'base',name:path.basename(mediaPath),path:mediaPath,
      dur:20,in:0,out:20,offset:0,vtrack:0,primary:true}],playhead:3};
  fs.writeFileSync(project,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(JSON.stringify(data),'utf16le')]));
  let child,client;
  const errors=[];
  try{
    const port=await reservePort();
    child=spawn(PACKAGED_EXE||ELECTRON,[...(!PACKAGED_EXE?['.']:[]),`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,
      '--subtool-transport-acceptance','--no-sandbox','--disable-background-timer-throttling',
      '--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',project],{
      cwd:ROOT,env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp},windowsHide:true,stdio:['ignore','ignore','pipe']});
    child.stderr.on('data',chunk=>errors.push(chunk.toString()));
    const target=await waitFor(async()=>{
      const targets=await getJSON(`http://127.0.0.1:${port}/json/list`);
      return targets.find(item=>item.type==='page'&&item.title==='SUB TOOL');
    },'主視窗啟動',30000);
    client=new CdpClient(target.webSocketDebuggerUrl);
    await client.connect(); await client.send('Runtime.enable');
    await waitFor(()=>client.evaluate('Boolean(window.SUB?.Media?.mpvMode && window.SUB.State.clips.length===1)'),
      '真 mpv 素材載入',30000);

    await client.evaluate(`(() => {
      const {State,Media}=window.SUB;
      const url=State.clips[0].web?.url;
      if(!url) throw new Error('素材未取得受授權的預覽網址');
      State.videoTracks=Array.from({length:7},(_,index)=>({visible:true,scale:index===0?1:0.5}));
      State.clips[0].proxyUrl=url;
      State.clips.push({id:'overlay',name:'overlay',path:${JSON.stringify(mediaPath)},proxyUrl:url,
        offset:6,in:0,out:1.5,dur:1.5,vtrack:1,scale:0.5});
      for(let index=2;index<=6;index++) State.clips.push({id:'overlay-'+index,name:'overlay-'+index,
        path:${JSON.stringify(mediaPath)},proxyUrl:url,offset:4+index*2,in:0,out:1.5,dur:1.5,
        vtrack:index,scale:0.5});
      Media.seek(3).catch(()=>{});
      return true;
    })()`);
    let warm;
    try{
      warm=await waitFor(()=>client.evaluate(`(() => {
        const p=window.SUB.WC.preview, s=p.stats();
        if(s.mode!=='mpv'||s.sources.length<2||s.sources.some(x=>x.state!=='ready'||x.frames===0)) return null;
        return s;
      })()`),'mpv 正播時兩層第一張畫格預熱',10000);
    }catch(error){
      const state=await client.evaluate(`(() => ({time:window.SUB.Media.displayTime(),seq:window.SUB.Media.seqOn(),
        clips:window.SUB.State.clips, tracks:window.SUB.State.videoTracks,
        preview:window.SUB.WC.preview.stats()}))()`);
      error.message+=`\nRenderer state: ${JSON.stringify(state)}`;
      throw error;
    }

    await client.evaluate('window.SUB.Media.seek(6.25).catch(()=>{})');
    const composite=await waitFor(()=>client.evaluate(`(() => {
      const p=window.SUB.WC.preview;
      if(p.mode!=='wc'||!window.SUB.Media.webCodecsTakeover()) return null;
      return {mode:p.mode,sourceCount:p.sources.size,display:window.SUB.Media.displayTime(),stats:p.stats()};
    })()`),'疊層 WebCodecs 接管',10000);

    const traversal=[];
    for(const at of [8.25,10.25,12.25,14.25,16.25]){
      await client.evaluate(`window.SUB.Media.seek(${at}).catch(()=>{})`);
      const state=await waitFor(()=>client.evaluate(`(() => {
        const p=window.SUB.WC.preview;
        if(p.mode!=='wc'||Math.abs(window.SUB.Media.displayTime()-${at})>0.1) return null;
        return {at:${at},sourceCount:p.sources.size};
      })()`),`第 ${at} 秒疊層接管`,10000);
      if(state.sourceCount>5) throw new Error(`預覽工作集超出預算：${JSON.stringify(state)}`);
      traversal.push(state);
    }
    await client.evaluate('window.SUB.Media.seek(19).catch(()=>{})');
    const pruned=await waitFor(()=>client.evaluate(`(() => {
      const p=window.SUB.WC.preview;
      if(p.sources.size>1) return null;
      return {mode:p.mode,sourceCount:p.sources.size,stats:p.stats()};
    })()`),'離開疊層後淘汰來源',5000);
    const subtitle=await client.evaluate(`(() => {
      const {State,renderVideoSub}=window.SUB;
      State.trackCount=4;
      State.tracks=Array.from({length:4},()=>({visible:true}));
      State.cues=Array.from({length:5000},(_,index)=>({id:'perf-'+index,
        start:index*0.2,end:index*0.2+0.12,track:index%4,text:'字幕 '+index}));
      renderVideoSub();
      const frame=Math.round(window.SUB.Media.displayTime()*24);
      const oldStarted=performance.now();
      for(let pass=0;pass<300;pass++) for(let track=0;track<4;track++)
        State.cues.filter(c=>(c.track||0)===track&&c.timed!==false
          &&frame>=Math.round(c.start*24)&&frame<Math.round(c.end*24));
      const oldScanMs=performance.now()-oldStarted;
      const started=performance.now();
      for(let index=0;index<300;index++) renderVideoSub(true);
      return {cueCount:State.cues.length,frames:300,
        previousFullScanMs:Number(oldScanMs.toFixed(1)),previewRenderMs:Number((performance.now()-started).toFixed(1))};
    })()`);
    console.log(JSON.stringify({ok:true,warm,composite,traversal,pruned,subtitle},null,2));
  }catch(error){
    error.message+=errors.length?`\nElectron stderr:\n${errors.join('').slice(-4000)}`:'';
    throw error;
  }finally{
    client?.close();
    if(child){
      try{ execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}); }catch(e){}
      if(child.exitCode===null) await Promise.race([new Promise(resolve=>child.once('close',resolve)),delay(5000)]);
    }
    verifiedCleanup(profile,'subtool-preview-cdp-');
  }
}

main().catch(error=>{console.error(error.stack||error.message||String(error));process.exitCode=1;});

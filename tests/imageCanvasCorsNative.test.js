// @subtool-ci windows
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { nativeTestTools } from './fixtures/native-tools.cjs';

const require=createRequire(import.meta.url);
const { ROOT, ELECTRON, reservePort, getJSON, waitFor, CdpClient, trackElectron, stopElectron, verifiedCleanup }
  =require('../scripts/acceptance/cdp-electron-harness.js');
const {ffmpeg:FFMPEG}=nativeTestTools();

it.skipIf(process.platform!=='win32'||!existsSync(ELECTRON)||!existsSync(FFMPEG))('授權本機圖片的預覽、截圖及 WebCodecs 合成都保留可讀取的像素',async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'subtool-image-cors-'));
  const png=path.join(directory,'red.png'),video=path.join(directory,'green.mp4'),project=path.join(directory,'image.subtool');
  execFileSync(FFMPEG,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=red:s=64x36','-frames:v','1',png],{windowsHide:true});
  execFileSync(FFMPEG,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=lime:s=64x36:r=25:d=2',
    '-c:v','libx264','-pix_fmt','yuv420p',video],{windowsHide:true});
  writeFileSync(project,JSON.stringify({app:'SUB Tool',version:3,fps:25,duration:5,
    media:{name:path.basename(video),path:video,size:statSync(video).size},tracks:[],cues:[],notes:[],
    videoTracks:[{name:'V1',visible:true,locked:false},{name:'V2',visible:true,locked:false,scale:.5,posX:.5,posY:.5}],
    clips:[{id:'image',type:'image',name:'red',path:png,in:0,out:5,dur:5,offset:0,vtrack:0,natW:64,natH:36,
      scale:1,posX:.5,posY:.5},{id:'video',type:'video',name:'green',path:video,in:0,out:2,dur:2,offset:3,
      vtrack:1,natW:64,natH:36,primary:true}]}));
  const port=await reservePort();
  const child=trackElectron(spawn(ELECTRON,['.','--subtool-transport-acceptance',project,
    `--remote-debugging-port=${port}`,`--user-data-dir=${path.join(directory,'profile')}`,'--no-sandbox'],
  {cwd:ROOT,windowsHide:true,stdio:'ignore'}));
  let client;
  try{
    const target=await waitFor(async()=>(await getJSON(`http://127.0.0.1:${port}/json/list`))
      .find(item=>item.type==='page'&&item.title==='SUB TOOL'),'圖片預覽主視窗',10000);
    client=new CdpClient(target.webSocketDebuggerUrl);await client.connect();
    await waitFor(()=>client.evaluate(`Boolean(document.querySelector('#imageLayer img')?.complete
      &&document.querySelector('#imageLayer img')?.naturalWidth)`),'實際圖片元素',10000);
    const preview=await client.evaluate(`(() => {
      const image=document.querySelector('#imageLayer img');
      const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;
      canvas.getContext('2d').drawImage(image,0,0,16,16);
      return {pixel:[...canvas.getContext('2d').getImageData(8,8,1,1).data],png:canvas.toDataURL()};
    })()`);
    expect(preview.pixel).toEqual([253,0,0,255]);expect(preview.png).toMatch(/^data:image\/png;base64,/);
    // The public screenshot shortcut also loads the image independently; a fix
    // limited to the visible DOM element would still leave this canvas tainted.
    await client.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'t',bubbles:true,cancelable:true}));true`);
    const screenshot=await waitFor(()=>readdirSync(directory).find(file=>file.endsWith('.jpg')),'圖片截圖實際寫入',5000);
    const pixel=execFileSync(FFMPEG,['-hide_banner','-loglevel','error','-i',path.join(directory,screenshot),
      '-vf','crop=2:2:iw/2:ih/2,scale=1:1','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{windowsHide:true});
    expect(pixel[0]).toBeGreaterThan(240);expect(pixel[1]).toBeLessThan(10);expect(pixel[2]).toBeLessThan(10);
    // Moving into the upper video makes the normal presenter composite the
    // lower image into its own canvas, through a separate image loader.
    await client.evaluate('window.SUB.Media.seek(3.2);true');
    await waitFor(()=>client.evaluate('window.SUB.Media.previewComposition()?.imagesComposited===true'),
      '圖片與影片的 WebCodecs 實際合成',10000);
    const composition=await client.evaluate(`(() => {
      const canvas=document.querySelector('#previewCanvas'),context=canvas.getContext('2d');
      const stageWidth=Math.min(canvas.width,canvas.height*16/9);
      const pixel=x=>[...context.getImageData(Math.floor(canvas.width/2+stageWidth*x),Math.floor(canvas.height/2),1,1).data];
      return {outside:pixel(-.4),inside:pixel(0),png:canvas.toDataURL()};
    })()`);
    expect(composition.outside).toEqual([253,0,0,255]);
    // Decoder color conversion can change the green level; require a strongly
    // green video pixel as well as the exact red bitmap outside its PiP.
    expect(composition.inside[0]).toBeLessThan(10);expect(composition.inside[1]).toBeGreaterThan(180);
    expect(composition.inside[2]).toBeLessThan(10);expect(composition.inside[3]).toBe(255);
    expect(composition.png).toMatch(/^data:image\/png;base64,/);
  }finally{
    client?.close();await stopElectron(child);
    verifiedCleanup(directory,'subtool-image-cors-',{maxRetries:20,retryDelay:100});
  }
},30000);

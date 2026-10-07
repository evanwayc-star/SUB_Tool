/* ============================================================================
   時間軸媒體右鍵選單 —— Electron / CDP 驗收
   ============================================================================
   先執行 npm run build，再執行：
     node scripts/acceptance/verify-media-context-menus.js
   安裝版：設定 SUBTOOL_ACCEPTANCE_EXE 為正式安裝的 SUB Tool.exe 後執行。

   以真實影音素材載入桌面版，驗證影片、鎖定影片、影片原音與左側音訊列頭
   的最終選單順序。檔案定位 callback 的精確路徑另由 jsdom 整合測試覆蓋，
   這裡不真的打開檔案管理器，避免驗收時干擾使用者桌面。
   另外檢查 SVG／變速反轉標記的實際可見性，並以 880／330 Hz 非對稱音訊
   驗證兩倍速反轉的出聲方向與音高，以及固定畫面、幾何與存檔重開。
   ============================================================================ */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const {
  ROOT,
  ELECTRON,
  delay,
  reservePort,
  getJSON,
  waitFor,
  CdpClient, trackElectron, stopElectron,
  dispatchClick,
  verifiedCleanup,
} = require('./cdp-electron-harness.js');
const PACKAGED_EXE = process.env.SUBTOOL_ACCEPTANCE_EXE
  ? path.resolve(process.env.SUBTOOL_ACCEPTANCE_EXE) : null;

function projectBytes(mediaPath, size) {
  const data = {
    app: 'SUB Tool',
    version: 3,
    media: { name: path.basename(mediaPath), size, path: mediaPath },
    duration: 6,
    fps: 25,
    tracks: [],
    cues: [],
    notes: [],
    videoTracks: [{ name: '視訊軌 1', visible: true, locked: false }],
    clips: [{
      id: 'menu-acceptance-primary',
      name: path.basename(mediaPath),
      path: mediaPath,
      dur: 6,
      in: 0,
      out: 6,
      offset: 0,
      vtrack: 0,
      primary: true,
      locked: false,
    }],
    playhead: 1,
  };
  return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(JSON.stringify(data), 'utf16le')]);
}

async function elementRect(client, selector) {
  return waitFor(() => client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  })()`), selector, 15000);
}

async function openMenu(client, selector) {
  await client.evaluate(`(() => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    return true;
  })()`);
  await delay(50);
  const rect = await elementRect(client, selector);
  await dispatchClick(client, rect, 'right');
  await waitFor(
    () => client.evaluate(`document.getElementById('ctxmenu')?.classList.contains('show') === true`),
    `${selector} 右鍵選單`,
    5000
  );
  return client.evaluate(`(() => [...document.querySelectorAll('#ctxmenu > *')].map(element => ({
    id: element.dataset.menuId || '',
    text: element.textContent.trim(),
    role: element.getAttribute('role') || '',
  })))()`);
}

function ids(items) {
  return items.map(item => item.id);
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('找不到 dist/index.html，請先執行 npm run build');
  }
  const profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-menu-cdp-'));
  const fixturePath = path.join(profileDir, 'menu-fixture.mp4');
  const projectPath = path.join(profileDir, 'menu-acceptance.subtool');
  const screenshotPath = path.join(os.tmpdir(), 'subtool-media-context-menu-acceptance.png');
  const ffmpeg = path.join(ROOT, 'electron', 'ffmpeg', 'ffmpeg.exe');
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=25',
    '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,3),0.16*sin(2*PI*330*t),0.32*sin(2*PI*880*t))':s=48000",
    '-t', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', fixturePath,
  ], { cwd: ROOT, windowsHide: true, stdio: 'pipe' });
  fs.writeFileSync(projectPath, projectBytes(fixturePath, fs.statSync(fixturePath).size));

  const port = await reservePort();
  const errors = [];
  const child = trackElectron(spawn(PACKAGED_EXE || ELECTRON, [
    ...(PACKAGED_EXE ? [] : ['.']),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--subtool-transport-acceptance',
    projectPath,
  ], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  }));
  child.stderr.on('data', chunk => errors.push(chunk.toString()));

  let client;
  try {
    const target = await waitFor(async () => {
      const targets = await getJSON(`http://127.0.0.1:${port}/json/list`);
      return targets.find(item => item.type === 'page' && item.title === 'SUB TOOL');
    }, 'SUB Tool 主視窗啟動', 20000);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.bringToFront');
    await waitFor(
      () => client.evaluate(`Boolean(window.SUB?.State?.clips?.length === 1
        && document.querySelector('.clip-block')
        && document.querySelector('.audio-clip-block')
        && document.querySelector('.agtrack'))`),
      '影音片段與音訊列完成',
      30000
    );
    const appVersion = await client.evaluate(`document.getElementById('appVersion')?.textContent?.trim()`);
    assert.equal(appVersion, `v${require(path.join(ROOT, 'package.json')).version}`, 'App 內版本必須與本次發版一致');
    await client.evaluate('window.SUB.Media.seek(1); true');
    await delay(500);

    const videoMenu = await openMenu(client, '.clip-block');
    const menuIcons=await client.evaluate(`(() => ['detach_audio','hard_limiter'].map(id=>{
      const svg=document.querySelector('#ctxmenu [data-menu-id="'+id+'"] .c-icon svg');
      const rect=svg?.getBoundingClientRect(),style=svg&&getComputedStyle(svg);
      return {id,path:!!svg?.querySelector('path'),visible:!!rect&&rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'};
    }))()`);
    for(const icon of menuIcons) assert.ok(icon.path&&icon.visible,`${icon.id} 應有可見 SVG 圖示`);
    assert.deepEqual(ids(videoMenu), [
      'heading',
      'reveal_source',
      'seek_clip_start',
      'separator',
      'split_at_playhead',
      'edit_duration',
      'edit_speed',
      'freeze_clip',
      'edit_geometry',
      'separator',
      'detach_audio',
      'hard_limiter',
      'audio_routing',
      'separator',
      'move_track_up',
      'separator',
      'fade',
      'crossfade_previous',
      'separator',
      'remove_clip',
    ]);

    await client.evaluate(`(() => {
      window.SUB.State.videoTracks[0].locked = true;
      window.SUB.drawTimeline();
      return true;
    })()`);
    await delay(150);
    const lockedVideoMenu = await openMenu(client, '.clip-block');
    assert.deepEqual(ids(lockedVideoMenu), [
      'heading', 'locked_status', 'reveal_source', 'seek_clip_start',
    ]);
    assert.equal(lockedVideoMenu.find(item => item.id === 'locked_status')?.role, 'status');

    await client.evaluate(`(() => {
      window.SUB.State.videoTracks[0].locked = false;
      window.SUB.State.clips[0].locked = true;
      window.SUB.drawTimeline();
      return true;
    })()`);
    await delay(150);
    const lockedAudioMenu = await openMenu(client, '.audio-clip-block');
    assert.ok(ids(lockedAudioMenu).includes('locked_status'));
    assert.ok(ids(lockedAudioMenu).includes('reveal_source'));
    assert.ok(ids(lockedAudioMenu).includes('speech_recognition'));
    assert.ok(ids(lockedAudioMenu).includes('audio_routing'));
    assert.ok(!ids(lockedAudioMenu).includes('remove_audio'));

    const gutterMenu = await openMenu(client, '.agtrack');
    assert.ok(ids(gutterMenu).includes('locked_status'));
    assert.ok(ids(gutterMenu).includes('reveal_source'));
    assert.ok(ids(gutterMenu).includes('audio_routing'));

    await delay(200);
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    const lockStyle = await client.evaluate(`(() => {
      const element = document.querySelector('#ctxmenu [data-menu-id="locked_status"]');
      const style = getComputedStyle(element);
      return { color: style.color, backgroundColor: style.backgroundColor, fontWeight: style.fontWeight };
    })()`);

    await client.evaluate(`(() => {
      window.SUB.State.clips[0].locked = false;
      window.SUB.drawTimeline();
      return true;
    })()`);
    await openMenu(client, '.clip-block');
    await client.evaluate(`document.querySelector('#ctxmenu [data-menu-id="edit_speed"]')?.click(); true`);
    await waitFor(()=>client.evaluate(`!!document.getElementById('clipSpeedPercent')`),'變速視窗',5000);
    await client.evaluate(`(() => {
      document.getElementById('clipSpeedPercent').value='200';
      document.getElementById('clipSpeedReverse').checked=true;
      [...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent==='套用').click();
      return true;
    })()`);
    const speedResult=await waitFor(()=>client.evaluate(`(() => {
      const c=window.SUB.State.clips[0];
      return c.speed===2&&c.reverse===true ? {
        speed:c.speed,reverse:c.reverse,duration:c.out/c.speed,
        mpvMode:window.SUB.Media.mpvMode,
      } : null;
    })()`),'速度與反轉套用',30000);
    assert.equal(speedResult.duration,3);
    assert.equal(speedResult.mpvMode,true);
    const clipIndicators=await client.evaluate(`(() => [...document.querySelectorAll('.clip-block [data-clip-effect]')].map(element=>{
      const svg=element.querySelector('svg'),rect=svg?.getBoundingClientRect(),style=getComputedStyle(element);
      return {effect:element.dataset.clipEffect,text:element.textContent.trim(),path:!!svg?.querySelector('path'),
        visible:!!rect&&rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden',pointerEvents:style.pointerEvents};
    }))()`);
    assert.deepEqual(clipIndicators.map(item=>item.effect).sort(),['reverse','speed']);
    for(const indicator of clipIndicators) assert.ok(indicator.path&&indicator.visible&&indicator.pointerEvents==='none','片段標記應可見且不攔截手勢');
    assert.ok(await client.evaluate(`!!document.querySelector('.audio-clip-block')`),'反轉影片仍顯示原音區塊');
    await waitFor(()=>client.evaluate(`!window.SUB.Media.mpvSourceTransitionPending()`),'反轉 Proxy 畫格就緒',10000);
    await client.evaluate(`window.SUB.Media.seek(0.5)`);
    await waitFor(()=>client.evaluate(`!window.SUB.Media.presentationPending() && !window.SUB.Media.mpvSourceTransitionPending()`),'反轉片段定位',10000);
    const before=await client.evaluate(`({timeline:window.SUB.Media.displayTime(),source:window.SUB.Media.vTime(),playing:window.SUB.Media.playing,pending:window.SUB.Media.presentationPending(),native:window.SUB.Media.mpvMode,switching:window.SUB.Media._seqSwitching,transition:window.SUB.Media.mpvSourceTransitionPending(),active:window.SUB.Media.activeClipId,rate:document.querySelector('video')?.playbackRate,mpvPath:window.SUB.Media._mpvPath,proxyPath:window.SUB.Media._reverseProxyPath,proxyActive:window.SUB.Media._reverseProxyActive})`);
    assert.ok(before.proxyActive && before.mpvPath===before.proxyPath,'反轉片段應由短 GOP Proxy 預覽');
    await client.evaluate(`(() => {
      window.__acceptanceAudioProbes=window.SUB.Media.tracks.filter(track=>track.gain&&window.SUB.Media.trackAudible(track)).map(track=>{
        const analyser=track.gain.context.createAnalyser();analyser.fftSize=4096;
        track.gain.connect(analyser);return {track,analyser};
      });return true;
    })()`);
    const audioContent=()=>client.evaluate(`(() => {
      return window.__acceptanceAudioProbes.map(({track,analyser})=>{
        const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
        let power=0,crossings=0;for(let i=0;i<samples.length;i++){power+=samples[i]*samples[i];if(i&&samples[i-1]<0&&samples[i]>=0)crossings++;}
        return {rms:Math.sqrt(power/samples.length),frequency:crossings*analyser.context.sampleRate/samples.length,audible:window.SUB.Media.trackAudible(track)};
      }).filter(sample=>sample.audible).sort((a,b)=>b.rms-a.rms)[0]||{rms:0,frequency:0};
    })()`);
    await client.evaluate(`window.SUB.Media.play(); true`);
    await delay(250);
    const reverseAudioFirst=await audioContent();
    assert.ok(reverseAudioFirst.rms>0.03,`反轉音訊不應靜音：${JSON.stringify(reverseAudioFirst)}`);
    assert.ok(Math.abs(reverseAudioFirst.frequency-880)<80,`反向開頭應播放來源片尾880Hz且維持音高：${JSON.stringify(reverseAudioFirst)}`);
    await delay(1600);
    const reverseAudioLast=await audioContent();
    assert.ok(reverseAudioLast.rms>0.03,`反轉片尾仍应出聲：${JSON.stringify(reverseAudioLast)}`);
    assert.ok(Math.abs(reverseAudioLast.frequency-330)<80,`反向片尾應播放來源片頭330Hz且維持音高：${JSON.stringify(reverseAudioLast)}`);
    const after=await client.evaluate(`({timeline:window.SUB.Media.displayTime(),source:window.SUB.Media.vTime(),playing:window.SUB.Media.playing,pending:window.SUB.Media.presentationPending(),native:window.SUB.Media.mpvMode,switching:window.SUB.Media._seqSwitching,transition:window.SUB.Media.mpvSourceTransitionPending(),active:window.SUB.Media.activeClipId,rate:document.querySelector('video')?.playbackRate,mpvPath:window.SUB.Media._mpvPath,proxyPath:window.SUB.Media._reverseProxyPath,proxyActive:window.SUB.Media._reverseProxyActive})`);
    assert.ok(after.timeline>before.timeline+0.15,`反轉後播放頭未前進：${JSON.stringify({before,after})}`);
    assert.ok(after.source<before.source-0.3,`反轉後來源畫格未倒退：${JSON.stringify({before,after})}`);
    await client.evaluate(`window.SUB.Media.pause(); true`);
    await client.evaluate(`(() => {for(const {track,analyser} of window.__acceptanceAudioProbes)track.gain.disconnect(analyser);delete window.__acceptanceAudioProbes;return true;})()`);

    await openMenu(client,'.clip-block');
    await client.evaluate(`document.querySelector('#ctxmenu [data-menu-id="freeze_clip"]')?.click(); true`);
    await waitFor(()=>client.evaluate(`!!document.getElementById('clipFreezeFrame')`),'固定畫面視窗',5000);
    await client.evaluate(`(() => {
      document.getElementById('clipFreezeFrame').value='26';
      [...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent==='固定畫面').click();
      return true;
    })()`);
    await waitFor(()=>client.evaluate(`window.SUB.State.clips[0]?.freezeTime===1 && !!window.SUB.State.clips[0]?.freezeWeb?.url`),'固定來源影格',30000);
    await client.evaluate(`window.SUB.Media.seek(0.2)`);
    await waitFor(()=>client.evaluate(`!window.SUB.Media.presentationPending() && window.SUB.Media.inGap()`),'固定畫面虛擬播放頭',10000);
    const fixedImage=()=>client.evaluate(`(() => {
      const image=document.querySelector('#imageLayer .img-wrap img');
      if(!image?.complete||!image.naturalWidth||getComputedStyle(image).visibility!=='visible') return null;
      const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
      canvas.getContext('2d').drawImage(image,0,0,64,36);
      return {pixels:canvas.toDataURL(),time:window.SUB.Media.displayTime(),duration:window.SUB.State.duration,freezeTime:window.SUB.State.clips[0].freezeTime};
    })()`);
    const freezeBefore=await waitFor(fixedImage,'固定畫面圖片呈現',10000);
    await client.evaluate(`window.SUB.Media.play(); true`);await delay(1000);
    const freezeAfter=await fixedImage();
    assert.ok(freezeAfter.time>freezeBefore.time+0.7,'固定期間播放頭應繼續前進');
    assert.equal(freezeBefore.pixels,freezeAfter.pixels,'固定期間來源畫面應保持同一幀');
    assert.equal(freezeAfter.duration,3,'固定不得改變變速片段長度');
    await client.evaluate(`window.SUB.Media.pause(); true`);

    // 幾何草稿跨過真實 modal、History 投影及存檔 seam；取消與一次提交
    // 必須同時適用於固定段，不能只靠一般圖片的 DOM 替身驗證。
    const geometry = () => client.evaluate(`(() => {
      const c=window.SUB.State.clips[0];
      return Object.fromEntries(['scale','posX','posY'].map(key=>[key,{present:Object.hasOwn(c,key),value:Object.hasOwn(c,key)?c[key]:null}]));
    })()`);
    const originalGeometry=await geometry();
    const editGeometry=async()=>{
      await openMenu(client,'.clip-block');
      await client.evaluate(`document.querySelector('#ctxmenu [data-menu-id="edit_geometry"]').click(); true`);
      await waitFor(()=>client.evaluate(`typeof document.getElementById('igS')?.oninput==='function'`),'幾何輸入事件就緒',5000);
      await client.evaluate(`(() => {
        for(const [id,value] of [['igS',75],['igX',65],['igY',40]]){
          const input=document.getElementById(id);input.value=String(value);
          input.dispatchEvent(new Event('input',{bubbles:true}));
        }
        return true;
      })()`);
    };
    await editGeometry();
    assert.equal((await geometry()).posX.value,0.65,'固定畫面位置應即時預覽');
    await client.evaluate(`window.SUB.Project.save()`);
    const previewSave=JSON.parse(fs.readFileSync(projectPath).subarray(2).toString('utf16le'));
    const savedPreviewGeometry=Object.fromEntries(['scale','posX','posY'].map(key=>[key,{
      present:Object.hasOwn(previewSave.clips[0],key),value:Object.hasOwn(previewSave.clips[0],key)?previewSave.clips[0][key]:null,
    }]));
    assert.deepEqual(savedPreviewGeometry,originalGeometry,'未套用的幾何草稿不得寫入正式專案');
    await client.evaluate(`[...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent==='取消').click(); true`);
    assert.deepEqual(await geometry(),originalGeometry,'取消應還原欄位數值及不存在的語意');

    const historyBeforeGeometry=await client.evaluate(`window.SUB.History.stack.length`);
    await editGeometry();
    await client.evaluate(`[...document.querySelectorAll('#modalFoot button')].find(button=>button.textContent==='套用').click(); true`);
    assert.equal(await client.evaluate(`window.SUB.History.stack.length`),historyBeforeGeometry+1,'幾何套用只應建立一筆 Undo');
    const committedGeometry=await geometry();
    const geometryRect=await waitFor(()=>client.evaluate(`(() => {
      const layer=document.getElementById('imageLayer');
      const box=layer?.querySelector('.img-wrap');
      if(!box||!layer.clientWidth||!layer.clientHeight) return null;
      const style=getComputedStyle(box);
      const w=parseFloat(style.width),h=parseFloat(style.height);
      return {scaleX:w/layer.clientWidth,scaleY:h/layer.clientHeight,
        centerX:(parseFloat(style.left)+w/2)/layer.clientWidth,
        centerY:(parseFloat(style.top)+h/2)/layer.clientHeight};
    })()`),'已提交固定畫面幾何呈現',5000);
    for(const [field,expected] of Object.entries({scaleX:0.75,scaleY:0.75,centerX:0.65,centerY:0.4})){
      assert.ok(Math.abs(geometryRect[field]-expected)<0.003,`可見固定段 ${field} 應為 ${expected}：${JSON.stringify(geometryRect)}`);
    }
    await client.evaluate(`window.SUB.History.undo(); true`);
    assert.deepEqual(await geometry(),originalGeometry,'Undo 應還原套用前幾何');
    await client.evaluate(`window.SUB.History.redo(); true`);
    assert.deepEqual(await geometry(),committedGeometry,'Redo 應恢復已提交幾何');

    // 使用正式存檔／桌面載入流程，驗證固定來源時間持久化，以及 reset 後
    // 從母素材重新建立預覽圖片；runtime capability URL 不得寫入專案。
    await client.evaluate(`window.__freezeReopenOriginalClip=window.SUB.State.clips[0]; true`);
    const savedProjectPath=await client.evaluate(`window.SUB.Project.save()`);
    assert.equal(savedProjectPath,projectPath,'固定畫面專案應由正式 save API 寫回已開啟路徑');
    const savedProjectBytes=fs.readFileSync(projectPath);
    assert.equal(savedProjectBytes.subarray(0,2).toString('hex'),'fffe','正式專案應保留 UTF-16LE BOM');
    const savedProject=JSON.parse(savedProjectBytes.subarray(2).toString('utf16le'));
    const savedFixed=savedProject.clips[0];
    assert.equal(savedFixed.freezeTime,1,'專案必须保存固定來源時間');
    assert.equal(savedFixed.path,fixturePath,'固定段必須保存母影片來源');
    assert.equal(savedFixed.speed,2,'固定段必須保存原速度');
    assert.equal(savedFixed.reverse,true,'固定段必須保存原反轉設定');
    assert.equal(savedFixed.scale,0.75,'正式保存應包含已套用大小');
    assert.equal(savedFixed.posX,0.65,'正式保存應包含已套用水平位置');
    assert.equal(savedFixed.posY,0.4,'正式保存應包含已套用垂直位置');
    assert.equal(savedProject.duration,3,'保存時應以變速後時間軸長度計算專案時長');
    assert.equal(Object.hasOwn(savedFixed,'freezeWeb'),false,'專案不得保存固定畫面 runtime URL');
    assert.equal(JSON.stringify(savedProject).includes('freezeWeb'),false,'整份專案不得夾帶固定預覽快取');

    await client.evaluate(`window.SUB.Project.loadDesktop(${JSON.stringify({path:projectPath,b64:savedProjectBytes.toString('base64')})})`);
    await waitFor(()=>client.evaluate(`(() => {
      const c=window.SUB.State.clips[0];
      return window.SUB.State.clips.length===1 && c!==window.__freezeReopenOriginalClip
        && c.freezeTime===1 && !!c.freezeWeb?.url && !window.SUB.Media.presentationPending()
        && window.SUB.Media.inGap();
    })()`),'固定畫面專案重開並重建預覽',30000);
    const freezeReopened=await waitFor(fixedImage,'重開後可見固定 PNG',10000);
    assert.equal(freezeReopened.pixels,freezeBefore.pixels,'重開後應顯示保存時的同一來源幀');
    assert.equal(freezeReopened.freezeTime,1,'重開後仍固定於來源第 26 格');
    assert.equal(freezeReopened.duration,3,'重開後仍保留變速片段時間軸長度');
    const reopenedClip=await client.evaluate(`(() => {
      const c=window.SUB.State.clips[0];
      return {path:c.path,speed:c.speed,reverse:c.reverse};
    })()`);
    assert.deepEqual(reopenedClip,{path:fixturePath,speed:2,reverse:true});
    assert.deepEqual(await geometry(),committedGeometry,'正式重開應恢復已提交幾何');
    await client.evaluate(`delete window.__freezeReopenOriginalClip; true`);

    const frozenMenu=await openMenu(client,'.clip-block');
    assert.ok(ids(frozenMenu).includes('split_at_playhead'),'固定段仍可切割');
    assert.ok(ids(frozenMenu).includes('unfreeze_clip'),'固定段可解除');
    await client.evaluate(`document.querySelector('#ctxmenu [data-menu-id="unfreeze_clip"]').click(); true`);
    await waitFor(()=>client.evaluate(`window.SUB.State.clips[0].freezeTime==null && !window.SUB.Media.inGap()`),'解除固定恢復影片',10000);

    console.log(JSON.stringify({
      appVersion,
      videoMenu: ids(videoMenu),
      lockedVideoMenu: ids(lockedVideoMenu),
      lockedAudioMenu: ids(lockedAudioMenu),
      gutterMenu: ids(gutterMenu),
      lockStyle,
      speedResult,
      menuIcons,clipIndicators,reversePlayback:{before,after,audioFirst:reverseAudioFirst,audioLast:reverseAudioLast},
      freezePlayback:{before:{...freezeBefore,pixels:undefined},after:{...freezeAfter,pixels:undefined}},
      freezeProjectReopen:{savedFreezeTime:savedFixed.freezeTime,savedDuration:savedProject.duration,
        savedRuntimePreview:false,reopened:{...freezeReopened,pixels:undefined},...reopenedClip},
      geometryEdit:{original:originalGeometry,committed:committedGeometry,visible:geometryRect,previewExcludedFromSave:true,undoRedo:true},
      screenshotPath,
    }, null, 2));
  } finally {
    client?.close();
    await stopElectron(child);
    verifiedCleanup(profileDir, 'subtool-menu-cdp-');
    if (errors.length) {
      const important = errors.join('').split(/\r?\n/).filter(line => /error|failed|exception/i.test(line));
      if (important.length) console.warn(important.join('\n'));
    }
  }
})().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

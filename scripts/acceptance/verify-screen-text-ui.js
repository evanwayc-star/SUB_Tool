/* 畫面文字辨識 UI：先 npm run build，再 node scripts/acceptance/verify-screen-text-ui.js。
 * 已安裝版可設 SUBTOOL_ACCEPTANCE_EXE，直接啟動該 EXE 並使用其封裝的 ffmpeg。
 * 使用獨立 profile、產生的影片與真正右鍵選單；驗證寬窄視窗、無金鑰提示及加密設定。
 * 只儲存無效測試金鑰，不啟動雲端辨識。截圖保留在系統 TEMP，profile 關閉後清除。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { execFileSync, spawn } = require('node:child_process');
const { ROOT, ELECTRON, reservePort, getJSON, waitFor, delay, isMainWindowTarget,
  CdpClient, trackElectron, stopElectron, dispatchClick, verifiedCleanup } = require('./cdp-electron-harness');
const installedExe = process.env.SUBTOOL_ACCEPTANCE_EXE ? path.resolve(process.env.SUBTOOL_ACCEPTANCE_EXE) : null;
const executable = installedExe || ELECTRON;
const nativeRoot = installedExe
  ? path.join(path.dirname(installedExe), 'resources', 'app.asar.unpacked', 'electron')
  : path.join(ROOT, 'electron');
const ffmpeg = path.join(nativeRoot, 'ffmpeg', 'ffmpeg.exe');

async function elementRect(client, selector) {
  return waitFor(() => client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return { left:rect.left, top:rect.top, width:rect.width, height:rect.height };
  })()`), selector);
}

async function clickControl(client, selector) {
  await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'}); true`);
  await dispatchClick(client, await elementRect(client, selector));
}

async function pressKey(client, key, code, windowsVirtualKeyCode, modifiers = 0) {
  const event = { key, code, windowsVirtualKeyCode, modifiers };
  await client.send('Input.dispatchKeyEvent', { type:'keyDown', ...event });
  await client.send('Input.dispatchKeyEvent', { type:'keyUp', ...event });
}

async function selectOption(client, selector, value) {
  const index = await client.evaluate(`Array.from(document.querySelector(${JSON.stringify(selector)}).options)
    .findIndex(option => option.value === ${JSON.stringify(value)})`);
  assert.ok(index >= 0, `${selector} 缺少選項 ${value}`);
  await clickControl(client, selector);
  await pressKey(client,'Home','Home',36);
  for (let i = 0; i < index; i++) await pressKey(client,'ArrowDown','ArrowDown',40);
  await pressKey(client,'Enter','Enter',13);
  await waitFor(() => client.evaluate(`document.querySelector(${JSON.stringify(selector)}).value === ${JSON.stringify(value)}`),
    `${selector} 選擇 ${value}`);
}

async function typeText(client, selector, text) {
  await clickControl(client, selector);
  await pressKey(client,'a','KeyA',65,2);
  await client.send('Input.insertText', { text });
}

async function openRecognition(client) {
  await delay(180);
  await dispatchClick(client, await elementRect(client, '.clip-block'), 'right');
  let menu;
  try { menu = await elementRect(client, '#ctxmenu [data-menu-id="screen_text_recognition"]'); }
  catch (error) {
    await capture(client,path.join(os.tmpdir(),'subtool-screen-text-ui-failed.png'),false);
    const state = await client.evaluate(`({menu:document.getElementById('ctxmenu').textContent,
      visible:document.getElementById('ctxmenu').className,
      clip:document.querySelector('.clip-block').getBoundingClientRect().toJSON(),
      viewport:{width:innerWidth,height:innerHeight}})`);
    throw new Error(error.message+': '+JSON.stringify(state));
  }
  await dispatchClick(client, menu);
  await waitFor(() => client.evaluate(`Boolean(document.getElementById('ocrProvider')
    && !document.getElementById('ocrProvider').disabled)`), '雲端辨識設定已載入');
}

async function capture(client, filename, waitForModal = true) {
  if (waitForModal) await waitFor(() => client.evaluate(`(() => {
    const backdrop = document.getElementById('modalBg');
    const modal = backdrop?.querySelector('.modal');
    if (!modal || !backdrop.classList.contains('show')) return false;
    const animating = document.getAnimations().some(animation => {
      const target = animation.effect?.target;
      return target && backdrop.contains(target) && animation.playState === 'running';
    });
    return !animating && Number(getComputedStyle(modal).opacity) === 1
      && Number(getComputedStyle(backdrop).opacity) === 1;
  })()`), '對話框進場動畫完成且完全不透明');
  const screenshot = await client.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  fs.writeFileSync(filename, Buffer.from(screenshot.data, 'base64'));
}

async function layout(client) {
  return client.evaluate(`(() => {
    const modal = document.querySelector('#modalBg .modal');
    const body = document.getElementById('modalBody');
    const rect = modal.getBoundingClientRect();
    const footer = document.getElementById('modalFoot').getBoundingClientRect();
    const fields = [...body.querySelectorAll('input,select')].filter(field => {
      const r=field.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    });
    const start = document.getElementById('ocrStart').getBoundingClientRect();
    return {
      viewport:{width:innerWidth,height:innerHeight},
      modal:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom},
      footerVisible:footer.top >= 0 && footer.bottom <= innerHeight + 1,
      startVisible:start.top >= 0 && start.bottom <= innerHeight + 1,
      horizontalOverflow:body.scrollWidth > body.clientWidth + 1,
      fieldsInside:fields.every(field => { const r=field.getBoundingClientRect(); return r.left>=rect.left && r.right<=rect.right; }),
      scrollable:body.scrollHeight > body.clientHeight,
      scrollTop:body.scrollTop,
      keyType:document.getElementById('ocrApiKey').type,
      provider:document.getElementById('ocrProvider').value,
      model:document.getElementById('ocrModel').value,
      modelTag:document.getElementById('ocrModel').tagName,
      modelOptions:Array.from(document.getElementById('ocrModel').options || []).map(option=>option.value),
      customModel:document.getElementById('ocrCustomModel').value,
      customVisible:document.getElementById('ocrCustomModel').getBoundingClientRect().height > 0,
      customDisabled:document.getElementById('ocrCustomModel').disabled,
      sourceLang:document.getElementById('ocrSourceLang').value,
      width:document.getElementById('ocrFrameWidth').value,
      rate:document.getElementById('ocrSampleFps').value,
      smart:document.getElementById('ocrSmartAccuracy').checked,
    };
  })()`);
}

function assertLayout(value) {
  assert.ok(value.modal.left >= -1 && value.modal.top >= -1
    && value.modal.right <= value.viewport.width + 1 && value.modal.bottom <= value.viewport.height + 1,
  `對話框須在視窗內：${JSON.stringify(value)}`);
  assert.ok(value.footerVisible && value.startVisible, '開始辨識與頁尾需保持可見');
  assert.ok(!value.horizontalOverflow && value.fieldsInside, '欄位不得產生水平溢出');
}

(async () => {
  assert.ok(fs.existsSync(executable), `找不到驗收執行檔：${executable}`);
  assert.ok(fs.existsSync(ffmpeg), `找不到驗收所需的 ffmpeg：${ffmpeg}`);
  if (!installedExe) assert.ok(fs.existsSync(path.join(ROOT, 'dist', 'index.html')), '請先執行 npm run build');
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-screen-text-ui-'));
  const screenshots = Object.fromEntries(['wide','custom','narrow','credentials'].map(name =>
    [name,path.join(os.tmpdir(), `subtool-screen-text-ui-${name}.png`)]));
  let client, child;
  try {
    const source = path.join(profile, 'screen-text-fixture.mp4');
    execFileSync(ffmpeg, [
      '-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=navy:s=640x360:r=25',
      '-t','4','-c:v','libx264','-pix_fmt','yuv420p',source,
    ], { windowsHide:true, stdio:'pipe', timeout:20000 });
    const projectPath = path.join(profile, 'screen-text-fixture.subtool');
    const project = { app:'SUB Tool', version:3, fps:25, duration:4, playhead:0,
      media:{ name:path.basename(source), size:fs.statSync(source).size, path:source },
      tracks:[], cues:[], notes:[], videoTracks:[{name:'視訊軌 1',visible:true,locked:false}],
      clips:[{id:'screen-text-source',name:'字卡辨識測試.mp4',path:source,in:0,out:4,dur:4,offset:0,vtrack:0,primary:true}],
    };
    fs.writeFileSync(projectPath, Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(JSON.stringify(project),'utf16le')]));
    const port = await reservePort();
    // Even if the workstation has working cloud credentials, this acceptance must stay offline.
    const env = { ...process.env, OPENAI_API_KEY:'', GEMINI_API_KEY:'', GOOGLE_API_KEY:'' };
    child = trackElectron(spawn(executable, [...(installedExe ? [] : ['.']), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--subtool-transport-acceptance','--disable-background-timer-throttling','--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',projectPath], { cwd:ROOT, env, windowsHide:true, stdio:'ignore' }));
    const target = await waitFor(async () => (await getJSON(`http://127.0.0.1:${port}/json/list`)).find(isMainWindowTarget),
      'SUB Tool 主視窗啟動',20000);
    if (installedExe) assert.equal(path.normalize(fileURLToPath(target.url)).toLowerCase(),
      path.join(path.dirname(installedExe), 'resources', 'app.asar', 'dist', 'index.html').toLowerCase(),
      '安裝版驗收必須載入指定 EXE 的封裝頁面');
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.bringToFront');
    try {
      await waitFor(() => client.evaluate(`Boolean(window.SUB?.State.clips.some(clip=>clip.path===${JSON.stringify(source)})
        && document.querySelector('.clip-block'))`), '設定與測試專案載入',30000);
    } catch (error) {
      const state = await client.evaluate(`({clips:window.SUB?.State.clips.map(clip=>({id:clip.id,path:clip.path,name:clip.name})),
        title:document.getElementById('modalTitle')?.textContent,body:document.getElementById('modalBody')?.textContent,
        toast:document.getElementById('toast')?.textContent})`);
      throw new Error(error.message + ': ' + JSON.stringify(state));
    }
    await client.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await openRecognition(client);
    await delay(180);
    const wide = await layout(client);
    assertLayout(wide);
    assert.deepEqual({provider:wide.provider,model:wide.model,sourceLang:wide.sourceLang,width:wide.width,rate:wide.rate,smart:wide.smart},
      {provider:'openai',model:'gpt-5.4',sourceLang:'auto',width:'1920',rate:'10',smart:true});
    assert.equal(wide.keyType,'password');
    assert.equal(wide.modelTag,'SELECT');
    assert.deepEqual(wide.modelOptions,['gpt-5.4-mini','gpt-5.4','__custom__']);
    assert.ok(!wide.customVisible && wide.customDisabled,'預設模型應隱藏並停用自訂欄位');
    await capture(client,screenshots.wide);
    await dispatchClick(client,await elementRect(client,'#ocrStart'));
    assert.match(await client.evaluate("document.getElementById('ocrError').textContent"),/API 金鑰/);
    assert.equal(await client.evaluate("Boolean(document.getElementById('ocrProgressBar'))"),false);

    await selectOption(client,'#ocrModel','gpt-5.4');
    await selectOption(client,'#ocrModel','__custom__');
    await clickControl(client,'#ocrStart');
    assert.equal(await client.evaluate("document.getElementById('ocrCustomModel').validity.valid"),false);
    await typeText(client,'#ocrCustomModel','   ');
    await clickControl(client,'#ocrStart');
    assert.equal(await client.evaluate("document.getElementById('ocrCustomModel').validity.valid"),false);
    assert.equal(await client.evaluate("Boolean(document.getElementById('ocrProgressBar'))"),false);
    await typeText(client,'#ocrCustomModel','gpt-acceptance-draft');
    await typeText(client,'#ocrApiKey','subtool-draft-only-never-send');
    await selectOption(client,'#ocrProvider','gemini');
    const gemini = await layout(client);
    assert.deepEqual(gemini.modelOptions,['gemini-2.5-flash','gemini-2.5-pro','__custom__']);
    assert.equal(gemini.model,'gemini-2.5-pro');
    assert.equal(await client.evaluate("document.getElementById('ocrApiKey').value"),'');
    await selectOption(client,'#ocrModel','gemini-2.5-pro');
    await selectOption(client,'#ocrModel','__custom__');
    await typeText(client,'#ocrCustomModel','gemini-acceptance-draft');
    await selectOption(client,'#ocrProvider','openai');
    const custom = await layout(client);
    assertLayout(custom);
    assert.equal(custom.model,'__custom__');
    assert.equal(custom.customModel,'gpt-acceptance-draft');
    assert.ok(custom.customVisible && !custom.customDisabled);
    assert.equal(await client.evaluate("document.getElementById('ocrApiKey').value"),'');
    await selectOption(client,'#ocrProvider','gemini');
    assert.equal(await client.evaluate("document.getElementById('ocrCustomModel').value"),'gemini-acceptance-draft');
    await selectOption(client,'#ocrProvider','openai');
    await capture(client,screenshots.custom);

    await client.send('Emulation.setDeviceMetricsOverride',{width:620,height:560,deviceScaleFactor:1,mobile:false});
    await delay(180);
    const narrow = await layout(client);
    assertLayout(narrow);
    assert.ok(narrow.scrollable,'矮視窗應可垂直捲動');
    await client.evaluate("document.getElementById('modalBody').scrollTop = 10000; true");
    const scrolled = await layout(client);
    assert.ok(scrolled.scrollTop > 0,'捲動需確實改變可見內容');
    assertLayout(scrolled);
    await capture(client,screenshots.narrow);
    await dispatchClick(client,await elementRect(client,'#ocrCancel'));
    assert.equal(await client.evaluate("document.getElementById('modalBg').classList.contains('show')"),false);

    const testKey = 'subtool-acceptance-invalid-key-never-send';
    const saved = await client.evaluate(`window.subtool.saveScreenTextSettings({provider:'gemini',model:'gemini-legacy-custom-model',
      sourceLang:'ko',sampleFps:3,frameWidth:1024,smartAccuracy:false,apiKey:${JSON.stringify(testKey)}})`);
    assert.deepEqual(saved.hasApiKey,{openai:false,gemini:true});
    assert.ok(!JSON.stringify(saved).includes(testKey) && !Object.hasOwn(saved,'apiKey'),'公開設定不得回傳金鑰');
    const reread = await client.evaluate('window.subtool.getScreenTextSettings()');
    assert.deepEqual(reread,saved);
    const disk = fs.readFileSync(path.join(profile,'config','screen-text-settings.json'),'utf8');
    assert.ok(!disk.includes(testKey),'設定檔不得含明文金鑰');
    assert.equal(typeof JSON.parse(disk).encryptedKeys.gemini,'string');
    await client.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await openRecognition(client);
    assert.equal(await client.evaluate("document.getElementById('ocrApiKey').value"),'');
    assert.match(await client.evaluate("document.getElementById('ocrKeyStatus').textContent"),/已就緒/);
    const restored = await layout(client);
    assertLayout(restored);
    assert.equal(restored.provider,'gemini');
    assert.equal(restored.model,'__custom__');
    assert.equal(restored.customModel,'gemini-legacy-custom-model');
    assert.ok(restored.customVisible && !restored.customDisabled,'未列入選單的已存模型須保留');
    assert.equal(restored.width,'1024');
    assert.equal(restored.sourceLang,'ko');
    await capture(client,screenshots.credentials);
    await selectOption(client,'#ocrModel','gemini-2.5-pro');
    const preset = await layout(client);
    assert.ok(!preset.customVisible && preset.customDisabled,'選回預設選項後自訂欄位不得參與驗證');
    // Never click Start once the dummy credential is stored.
    await dispatchClick(client,await elementRect(client,'#ocrCancel'));
    console.log(JSON.stringify({executable,applicationUrl:target.url,wide,custom,narrow,scrolled,restored,encryptedSettings:true,screenshots},null,2));
  } finally {
    client?.close();
    await stopElectron(child);
    verifiedCleanup(profile,'subtool-screen-text-ui-');
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

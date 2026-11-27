/* Windows: npm run build && node scripts/acceptance/verify-playhead-ocr.js
 * To test an installation, set SUBTOOL_ACCEPTANCE_EXE to its SUB Tool.exe.
 * Set SUBTOOL_OCR_TOOLBAR_PNG to capture the visible toolbar buttons.
 * --baseline measures the previous automatic whole-frame UI on the same clip.
 * --full-first starts a new application with a cold whole-frame request.
 * Creates its own profile, video, and project. All language recognition is local. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {fileURLToPath} = require('node:url');
const {execFileSync, spawn} = require('node:child_process');
const H = require('./cdp-electron-harness');

const installed = process.env.SUBTOOL_ACCEPTANCE_EXE ? path.resolve(process.env.SUBTOOL_ACCEPTANCE_EXE) : null;
const exe = installed || H.ELECTRON;
const toolsDir = installed ? path.join(path.dirname(exe), 'resources', 'app.asar.unpacked', 'electron') : path.join(H.ROOT, 'electron');
const headline = 'WEATHER REPORT', first = 'NORTH STATION', second = 'SOUTH MARKET', edited = '校訂北站\n旅客入口';
const whiteCaption = 'EVENING TRAIN';
const middle = 'TRACK SIX';
const baseline = process.argv.includes('--baseline'), fullFirst = process.argv.includes('--full-first');
const normalized = text => text.normalize('NFKC').trim().replace(/\s+/gu, ' ');

function createFixture(dir) {
  const video = path.join(dir, 'two-signs.mp4'), project = path.join(dir, 'playhead-ocr.subtool');
  fs.copyFileSync(path.join(process.env.WINDIR, 'Fonts', 'arial.ttf'), path.join(dir, 'ocr-font.ttf'));
  const label = (word, y, enabled = '1', ink = 'fontcolor=black') => `drawtext=fontfile=ocr-font.ttf:text='${word}':fontsize=72:${ink}:x=(w-tw)/2:y=h*${y}:enable='${enabled}'`;
  execFileSync(path.join(toolsDir, 'ffmpeg', 'ffmpeg.exe'), ['-hide_banner','-loglevel','error','-f','lavfi',
    '-i','color=white:size=960x540:rate=25:duration=11','-vf',
    [label(headline,.20),label(middle,.42,'between(n,100,109)'),label(first,.63,'lt(n,63)'),label(second,.63,'between(n,63,124)'),
      label('LIVE FRAME %{n}',.63,'between(n,125,199)'),
      "drawbox=x=0:y=ih*.52:w=iw:h=ih*.38:color=0x647788:t=fill:enable='gte(n,200)'",
      label(whiteCaption,.63,'gte(n,200)','fontcolor=white:borderw=4:bordercolor=black')].join(','),
    '-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-movflags','+faststart',video],
  {cwd:dir, windowsHide:true, stdio:'pipe'});
  const name = path.basename(video);
  const data = {app:'SUB Tool', version:3, fps:25, duration:11, playhead:0,
    media:{name, path:video, size:fs.statSync(video).size}, tracks:[{name:'原有字幕', visible:true, locked:false}],
    cues:[{track:1, text:'保留原字幕', start:4.48, end:4.92, timed:true}], notes:[],
    videoTracks:[{name:'視訊軌 1', visible:true, locked:false}],
    clips:[{id:'signs',name,path:video,in:0,out:11,dur:11,offset:0,vtrack:0,primary:true}]};
  fs.writeFileSync(project, Buffer.from('\ufeff' + JSON.stringify(data), 'utf16le'));
  return {video, project};
}

async function ctrl(client, letter, shift = false) {
  const keyCode = letter.charCodeAt(0);
  const keyEvent = {modifiers:shift ? 10 : 2, key:shift ? letter : letter.toLowerCase(), code:'Key' + letter,
    windowsVirtualKeyCode:keyCode, nativeVirtualKeyCode:keyCode};
  await client.send('Input.dispatchKeyEvent', {type:'rawKeyDown', ...keyEvent});
  await client.send('Input.dispatchKeyEvent', {type:'keyUp', ...keyEvent});
}

async function click(client, selector) {
  const box = await H.waitFor(() => client.evaluate(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)}), r=e?.getBoundingClientRect();
    return r?.width>0 && r.height>0 && {left:r.left,top:r.top,width:r.width,height:r.height};
  })()`), selector);
  await H.dispatchClick(client, box);
}

async function seek(client, t) {
  await client.evaluate(`window.SUB.Media.seek(${t}).then(result=>result?.status)`);
  await H.waitFor(() => client.evaluate(`Math.abs(SUB.Media.displayTime()-${t})<0.001 && !SUB.Media.presentationPending()`), '定位到 ' + t);
}

function workspace(client) {
  return client.evaluate(`({tracks:SUB.State.tracks.map(track=>track.name),
    cues:SUB.State.cues.map(({text,track,start,end,recognition})=>({text,track,start,end,original:recognition?.originalText})),
    history:SUB.History.hi})`);
}

// All three timestamps use the renderer clock. Polling CDP or moving the
// automation mouse must not count as time spent after starting recognition.
async function openShortcut(client, toolbar = false) {
  await client.evaluate(`(() => {
    window.__ocrProbe?.dispose();
    const $ = id => document.getElementById(id);
    const probe = {}, visible = el => el?.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    const onKey = e => {
      if (e.isTrusted && e.ctrlKey && e.code === 'KeyE') probe.key = performance.now();
    };
    const onUp = e => {
      if (e.isTrusted && e.target.closest('#playheadOcrToolbar')) probe.key = performance.now();
      if (e.isTrusted && e.target.closest('#playheadOcrStart')) {
        probe.start = performance.now();
        probe.review = null;
      }
    };
    const observe = () => {
      if (probe.key == null || !$('modalBg').classList.contains('show')) return;
      const region = document.querySelector('#playheadOcrRegion canvas'), start = $('playheadOcrStart');
      if (probe.selectable == null && visible(region) && region.width > 0 && visible(start)) {
        probe.selectable = performance.now();
        probe.dimensions = [region.width,region.height];
      }
      if (probe.review == null && visible($('playheadOcrText'))) probe.review = performance.now();
    };
    const observer = new MutationObserver(observe);
    observer.observe($('modalBg'), {attributes:true,subtree:true,childList:true,characterData:true});
    window.addEventListener('keydown',onKey,true);
    window.addEventListener('pointerup',onUp,true);
    probe.dispose = () => {
      observer.disconnect();
      window.removeEventListener('keydown',onKey,true);
      window.removeEventListener('pointerup',onUp,true);
    };
    window.__ocrProbe = probe;
    return true;
  })()`);
  if (toolbar) await click(client, '#playheadOcrToolbar[data-act="playhead-ocr"]');
  else await ctrl(client, 'E');
  if (baseline) return;
  await H.waitFor(() => client.evaluate('window.__ocrProbe.selectable != null'), 'Ctrl+E 顯示可操作的凍結畫布', 20000);
  assert.equal(await client.evaluate('window.__ocrProbe.review == null'), true, '選區前不得直接顯示整格辨識');
}

async function regionBox(client) {
  return client.evaluate(`(() => {
    const e=document.querySelector('#playheadOcrRegion canvas'), r=e.getBoundingClientRect();
    return {x:r.left,y:r.top,w:r.width,h:r.height};
  })()`);
}

const areas = {top:[.08,.12,.92,.38], bottom:[.08,.57,.92,.83], blank:[.08,.42,.92,.50],
  allRows:[.02,.06,.98,.90], middleHole:[.24,.395,.76,.57]};

async function dragArea(client, area, modifiers = 0) {
  const rect = await regionBox(client);
  const [l,t,r,b] = areas[area];
  const from = {x:rect.x + rect.w*l, y:rect.y + rect.h*t}, to = {x:rect.x + rect.w*r, y:rect.y + rect.h*b};
  await client.send('Input.dispatchMouseEvent', {type:'mousePressed', ...from, modifiers, button:'left', buttons:1, clickCount:1});
  await client.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...to, modifiers, button:'left', buttons:1});
  await client.send('Input.dispatchMouseEvent', {type:'mouseReleased', ...to, modifiers, button:'left', clickCount:1});
  assert.ok(await client.evaluate(`document.getElementById('playheadOcrStart').getBoundingClientRect().width > 0 &&
    !document.getElementById('playheadOcrStart').disabled && !document.getElementById('playheadOcrText').getBoundingClientRect().width`),
  '拖曳放開後應保留在設定，等候開始辨識');
}

async function doubleClickFrame(client) {
  const rect = await regionBox(client);
  const point = {x:rect.x+rect.w/2, y:rect.y+rect.h/2, button:'left'};
  for (const clickCount of [1,2]) {
    await client.send('Input.dispatchMouseEvent', {type:'mousePressed', ...point, buttons:1, clickCount});
    await client.send('Input.dispatchMouseEvent', {type:'mouseReleased', ...point, clickCount});
  }
}

async function readShortcutResult(client, mode = 'bottom', { moveTo, configure, toolbar } = {}) {
  await openShortcut(client, toolbar);
  if (!baseline) {
    if (moveTo != null) await seek(client, moveTo);
    if (configure) await configure(client);
    if (mode !== 'full') await dragArea(client, mode);
    await click(client, '#playheadOcrStart');
  }
  return readReview(client);
}

async function readReview(client) {
  await H.waitFor(() => client.evaluate('window.__ocrProbe.review != null'), '校對框出現', 90000);
  return client.evaluate(`(() => {
    const p = window.__ocrProbe;
    const elapsed = (a,b) => a != null && b != null ? Math.round(b-a) : null;
    return {status:document.getElementById('playheadOcrStatus').textContent,
      text:document.getElementById('playheadOcrText').value,
      framePixels:p.dimensions,keyToSelectableMs:elapsed(p.key,p.selectable),startToReviewMs:elapsed(p.start,p.review),
      keyToReviewMs:elapsed(p.key,p.review)};
  })()`);
}

async function recognize(client, time, mode, expected, options) {
  await seek(client, time);
  const result = await readShortcutResult(client, mode, options);
  assert.equal(normalized(result.text), normalized(expected), '畫格實際辨識文字 ' + JSON.stringify(result));
  if (!baseline) assert.ok(Number.isFinite(result.startToReviewMs), '未收到開始辨識按鈕的真實點擊');
  return result;
}

async function chooseWhiteEnglish(client) {
  await click(client, '#playheadOcrLanguageSummary');
  await click(client, '#playheadOcrOptions input[value=eng]');
  await click(client, '#playheadOcrLanguageSummary');
  await click(client, '#playheadOcrWhite');
  assert.deepEqual(await client.evaluate("Array.from(document.querySelectorAll('#playheadOcrOptions fieldset input:checked'), x=>x.value)"), ['eng']);
  assert.ok(await client.evaluate("document.getElementById('playheadOcrWhite').checked"));
}

async function cancel(client) {
  await click(client, '#modalFoot button:first-child');
  await closed(client);
}

async function verifyToolbar(client) {
  const separator = await client.evaluate(`(() => {
    const ocr=document.querySelector('#playheadOcrToolbar[data-act="playhead-ocr"]');
    const line=ocr?.nextElementSibling, split=line?.nextElementSibling;
    if (!line?.matches('.sep') || !split?.matches('[data-act="split-clip"]')) return null;
    const style=getComputedStyle(line), r=line.getBoundingClientRect();
    const a=ocr.getBoundingClientRect(), b=split.getBoundingClientRect();
    return {width:r.width,height:r.height,color:style.backgroundColor,visible:style.visibility==='visible' &&
      style.opacity!=='0' && a.right<=r.left && r.right<=b.left &&
      Math.abs(a.top+a.height/2-r.top-r.height/2)<2 && Math.abs(b.top+b.height/2-r.top-r.height/2)<2};
  })()`);
  assert.ok(separator?.visible && separator.width>=1 && separator.height>=1 &&
    !['transparent','rgba(0, 0, 0, 0)'].includes(separator.color), 'OCR 與切割之間須有實際繪出的分隔線 '+JSON.stringify(separator));
  if (process.env.SUBTOOL_OCR_TOOLBAR_PNG) {
    const clip = await client.evaluate(`(() => {
      const rect = action => document.querySelector('#tlToolbarOptions [data-act="'+action+'"]').getBoundingClientRect();
      const left=rect('notes'), right=rect('split-clip');
      const x=Math.floor(left.left)-3, y=Math.floor(Math.min(left.top,right.top))-4;
      return {x,y,width:Math.ceil(right.right)+3-x,height:Math.ceil(Math.max(left.bottom,right.bottom))+4-y,scale:2};
    })()`);
    const image = await client.send('Page.captureScreenshot', {format:'png', clip});
    fs.writeFileSync(process.env.SUBTOOL_OCR_TOOLBAR_PNG, Buffer.from(image.data, 'base64'));
  }
  const result = await recognize(client, 2.52, 'bottom', second, {toolbar:true});
  await cancel(client);
  return {text:result.text, separator};
}

async function measure(client) {
  const firstMode = baseline || fullFirst ? 'full' : 'bottom';
  const otherMode = firstMode === 'full' ? 'bottom' : 'full';
  // Each launch has a new main process and worker. Interleave warm trials on
  // the exact same source frame to avoid confounding position with crop time.
  const modes = [firstMode, ...(baseline ? ['full','full','full'] : [firstMode, otherMode, otherMode, firstMode, firstMode, otherMode])];
  const samples = [];
  for (const [i, mode] of modes.entries()) {
    const expected = mode === 'full' ? headline + ' ' + first : first;
    const result = await recognize(client, 1.24, mode, expected);
    samples.push({mode, worker:i === 0 ? 'cold' : 'warm', ...result});
    await cancel(client);
  }
  return samples;
}

async function verifyMasksAndBack(client) {
  const both = headline + ' ' + second, all = headline + ' ' + middle + ' ' + second;
  await seek(client, 4.16);
  await openShortcut(client);
  await dragArea(client, 'bottom');
  await dragArea(client, 'top', 8); // CDP Shift
  await click(client, '#playheadOcrStart');
  // The button is also present during PNG encoding. Ask the real single-job
  // native bridge about a second 1px frame before pressing Back. A busy reply
  // proves recognition reached the worker, without replacing the first result.
  const busy = await client.evaluate(`(async () => {
    const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
    const pngBase64=canvas.toDataURL('image/png').split(',')[1];
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      await window.subtool.recognizeFrameText({requestId:'acceptance-busy-check',pngBase64});
      return '第二個請求意外成功';
    } catch (error) { return error.message; }
  })()`);
  assert.match(busy, /已有單格文字辨識工作正在執行/, '返回前必須已有真實 OCR 請求在執行');
  await click(client, '#playheadOcrBack');
  await H.waitFor(() => client.evaluate("document.getElementById('playheadOcrStart').getBoundingClientRect().width > 0"), '返回原選區');
  assert.equal(await client.evaluate('window.__ocrProbe.review == null'), true, '返回必須發生在有辨識結果前');
  await click(client, '#playheadOcrStart');
  const union = await readReview(client);
  assert.equal(normalized(union.text), both, '返回後應保留兩個選區，排除範圍中間的第三行');
  await cancel(client);

  await openShortcut(client);
  await dragArea(client, 'allRows');
  await dragArea(client, 'middleHole', 1); // CDP Alt
  await click(client, '#playheadOcrStart');
  const hole = await readReview(client);
  assert.equal(normalized(hole.text), both, '內部挖洞應只移除中間一行');
  await click(client, '#playheadOcrReselect');
  await H.waitFor(() => client.evaluate("document.getElementById('playheadOcrStart').getBoundingClientRect().width > 0"), '校對返回設定');
  await doubleClickFrame(client);
  assert.ok(await client.evaluate("document.getElementById('playheadOcrStart').getBoundingClientRect().width > 0"), '雙擊重置後等候開始');
  await click(client, '#playheadOcrStart');
  const reset = await readReview(client);
  assert.equal(normalized(reset.text), all, '雙擊回復整張後三行皆須讀回');
  await cancel(client);
  return {union:union.text, hole:hole.text, full:reset.text, returnedWhileNativeBusy:true};
}

async function recognizePlaying(client) {
  await seek(client, 5.28);
  await click(client, '#playBtn');
  const start = await H.waitFor(() => client.evaluate('SUB.Media.playing && {time:SUB.Media.displayTime()}'), '開始播放');
  await H.waitFor(() => client.evaluate(`SUB.Media.playing && SUB.Media.displayTime() >= ${start.time} + .12`), '播放時鐘實際前進三格');
  // Observe the trusted physical key event before the application's handler pauses playback.
  await client.evaluate(`window.addEventListener('keydown', event => {
    window.__ocrKeySample={time:SUB.Media.displayTime(),playing:SUB.Media.playing,trusted:event.isTrusted,ctrl:event.ctrlKey,key:event.key};
  }, {capture:true,once:true}); true`);
  const result = await readShortcutResult(client);
  const frozen = await client.evaluate(`(() => {
    const time=SUB.Media.displayTime();
    return {key:window.__ocrKeySample,playing:SUB.Media.playing,time,tc:SUB.secToEncore(time,25,false)};
  })()`);
  assert.ok(frozen.key.playing && frozen.key.trusted && frozen.key.ctrl && frozen.key.key.toLowerCase() === 'e');
  assert.equal(frozen.playing, false);
  const frame = Math.round(frozen.key.time * 25);
  assert.equal(frozen.time, frame / 25, '應停在按鍵時的專案畫格');
  assert.ok(result.status.includes(frozen.tc), '面板必須顯示凍結的時碼');
  assert.equal(normalized(result.text), 'LIVE FRAME ' + frame, '實際辨識的影片燒入格號必須與按鍵時相同');
  await H.delay(240);
  assert.equal(await client.evaluate('SUB.Media.displayTime()'), frozen.time, '辨識完成後仍為同一靜止格');
  await click(client, '#modalFoot button:first-child'); await closed(client);
  return {playingAtKey:frozen.key.playing, observed:frozen.key.time, pausedAt:frozen.time, tc:frozen.tc, text:result.text};
}

async function closed(client) {
  await H.waitFor(() => client.evaluate("!document.getElementById('modalBg').classList.contains('show')"), '對話框關閉');
}

async function run() {
  assert.equal(process.platform, 'win32', '這支驗收使用 Windows 本機 OCR');
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-playhead-ocr-'));
  let client, child;
  try {
    const {project, video} = createFixture(profile);
    const port = await H.reservePort();
    child = H.trackElectron(spawn(exe, [...(installed ? [] : ['.']), '--subtool-transport-acceptance',
      '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
      '--remote-debugging-port=' + port, '--user-data-dir=' + profile, project],
    {cwd:H.ROOT, windowsHide:true, stdio:'ignore'}));
    const target = await H.waitFor(async () => (await H.getJSON(`http://127.0.0.1:${port}/json/list`)).find(H.isMainWindowTarget), '桌面啟動', 30000);
    if (installed) assert.equal(path.normalize(fileURLToPath(target.url)).toLowerCase(),
      path.join(path.dirname(exe), 'resources', 'app.asar', 'dist', 'index.html').toLowerCase());
    client = new H.CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Runtime.enable');
    await H.waitFor(() => client.evaluate(`window.SUB?.State.clips.some(c=>c.path===${JSON.stringify(video)}) &&
      SUB.State.cues.some(c=>c.text==='保留原字幕') && document.querySelector('.clip-block')!=null`), '專案與影片就緒', 45000);
    assert.ok(await client.evaluate("typeof window.subtool?.recognizeFrameText === 'function'"), '此程式沒有本機 OCR bridge');
    const before = await workspace(client);
    const samples = await measure(client);
    assert.deepEqual(await workspace(client), before, '整格及框選校對取消均須保留原專案');
    if (baseline || fullFirst) {
      console.log(JSON.stringify({exe, baseline, samples}, null, 2));
      return;
    }
    const masks = await verifyMasksAndBack(client);
    assert.deepEqual(await workspace(client), before, '返回、重跑與取消必須保留原專案');
    const toolbar = await verifyToolbar(client);
    await openShortcut(client);
    await cancel(client);
    assert.deepEqual(await workspace(client), before, '未送入辨識直接取消也不應建立軌道');
    const blank = await recognize(client, 1.24, 'blank', '');
    assert.ok(await client.evaluate("document.getElementById('playheadOcrConfirm').disabled"), '空白範圍沒有可建立的字幕');
    await cancel(client);
    const live = await recognizePlaying(client);
    assert.deepEqual(await workspace(client), before, '播放中擷取後取消必須保留原專案');
    const cancelText = (await recognize(client, 2.48, 'bottom', first)).text;
    await cancel(client);
    assert.deepEqual(await workspace(client), before, '取消必須保留原軌道、字幕與歷程');

    const upper = await recognize(client, 2.52, 'top', headline);
    await cancel(client);
    // Move across the change in the lower label before dragging the frozen image.
    const firstText = (await recognize(client, 1.24, 'bottom', first, {moveTo:3.64})).text;
    await click(client, '#playheadOcrText'); await ctrl(client, 'A');
    await client.send('Input.insertText', {text:edited});
    await click(client, '#playheadOcrConfirm'); await closed(client);
    const original = before.cues[0];
    const firstCue = {text:edited, start:1.24, end:3.24, track:1, original:firstText};
    const afterFirst = await workspace(client);
    assert.deepEqual(afterFirst, {tracks:['原有字幕','OCR'], cues:[firstCue, original], history:before.history + 1});

    const secondText = (await recognize(client, 2.52, 'bottom', second)).text;
    await click(client, '#playheadOcrConfirm'); await closed(client);
    const secondCue = {text:secondText, start:2.52, end:4.52, track:1, original:secondText};
    const final = await workspace(client);
    assert.deepEqual(final, {tracks:afterFirst.tracks, cues:[firstCue, secondCue, original], history:before.history + 2});
    await ctrl(client, 'Z');
    await H.waitFor(() => client.evaluate('SUB.State.cues.length === 2'), '復原一筆');
    assert.deepEqual(await workspace(client), afterFirst);
    await ctrl(client, 'Z', true);
    await H.waitFor(() => client.evaluate('SUB.State.cues.length === 3'), '重做一筆');
    assert.deepEqual(await workspace(client), final);
    await ctrl(client, 'S');
    const saved = await H.waitFor(() => {
      const data = JSON.parse(fs.readFileSync(project, 'utf16le').replace(/^\ufeff/u,''));
      return data.cues.length === 3 && data;
    }, 'Ctrl+S 寫入專案');
    assert.deepEqual(saved.tracks.map(t => t.name), final.tracks);
    assert.deepEqual(saved.cues.map(c => ({text:c.text,start:c.start,end:c.end,track:c.track - 1,
      ...(c.recognition && {original:c.recognition.originalText})})), final.cues);
    const bytes = fs.readFileSync(project);
    await client.evaluate(`SUB.Project.loadDesktop(${JSON.stringify({path:project,b64:bytes.toString('base64')})}).then(()=>true)`);
    const reopened = await workspace(client);
    assert.deepEqual(reopened.cues, final.cues); assert.deepEqual(reopened.tracks, final.tracks);
    const enhanced = await recognize(client, 9, 'bottom', whiteCaption, {configure:chooseWhiteEnglish});
    await cancel(client);
    assert.deepEqual(await workspace(client), reopened, '白字英文校對取消保留原專案');
    console.log(JSON.stringify({exe, samples, masks, toolbar, live, blank:blank.text, upper:upper.text, whiteCaption:enhanced.text,
      cancelled:cancelText, originals:[firstText,secondText], reopened:reopened.cues}, null, 2));
  } finally {
    client?.close();
    if (child) await H.stopElectron(child);
    H.verifiedCleanup(profile, 'subtool-playhead-ocr-');
  }
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

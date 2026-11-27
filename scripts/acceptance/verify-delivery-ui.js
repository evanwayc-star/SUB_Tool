/* npm run build && node scripts/acceptance/verify-delivery-ui.js [證據目錄]
   使用隔離 Electron profile 與展示專案；檢查匯出表單的實際排版，不提交匯出。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureDocumentationWorkspace } = require('./capture-documentation-workspace.js');
const { delay, waitFor } = require('./cdp-electron-harness.js');

/* global document, getComputedStyle, innerWidth */
function measureDelivery() {
  const body = document.getElementById('modalBody');
  const box = element => element.getBoundingClientRect();
  const card = document.querySelector('.delivery-card');
  const controls = [...card.querySelectorAll('input,select,button')];
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const selectText = [...card.querySelectorAll('.ev-format,.ev-res,.ev-fps')].map(select => {
    const style = getComputedStyle(select);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const text = select.selectedOptions[0]?.textContent.trim() || '';
    const needed = context.measureText(text).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 4;
    return { text, width: box(select).width, needed, fits: box(select).width >= needed };
  });
  const horizontalOverflow = controls.filter(element => {
    const r = box(element), parent = box(card);
    return r.width && (r.left < parent.left - 1 || r.right > parent.right + 1);
  }).map(element => element.className);
  const chapter = card.querySelector('.delivery-chapter-options');
  const checkbox = chapter?.querySelector('input');
  const caption = checkbox?.nextElementSibling;
  const help = chapter?.querySelector('.delivery-option-help');
  const option = checkbox ? {
    aligned: Math.abs((box(checkbox).top + box(checkbox).height / 2) - (box(caption).top + box(caption).height / 2)) < 1,
    helpFits: box(help).left >= box(card).left && box(help).right <= box(card).right,
    description: document.getElementById(checkbox.getAttribute('aria-describedby'))?.textContent,
  } : null;
  return {
    width: innerWidth,
    scrollWidth: body.scrollWidth,
    clientWidth: body.clientWidth,
    horizontalOverflow,
    selectText,
    option,
    inputHeights: [...card.querySelectorAll('.delivery-select,.delivery-input')].map(element => box(element).height),
  };
}

async function inspectDelivery(client, dir) {
  await client.evaluate(`(() => {
    const { State, History } = window.SUB;
    State.clips = [{ id:'delivery-ui', name:'交付版面驗收.mov', path:'C:/UI-fixtures/交付版面驗收.mov',
      type:'video', in:0, out:120, offset:0, dur:120, duration:120, primary:true, vtrack:0 }];
    State.videoTracks = [{name:'V1',visible:true,locked:false}];
    State.cues = []; State.notes = [{id:'delivery-note',time:12,text:'章節備註'}];
    State.mediaName = '交付版面驗收.mov'; State.duration = 120;
    State.videoWidth = 1920; State.videoHeight = 1080;
    State.fps = 29.97; State.dropFrame = false;
    State.exportIn = null; State.exportOut = null;
    History.reset();
    document.querySelector('[data-act="exp-video"]').click();
  })()`);
  await waitFor(() => client.evaluate('Boolean(document.querySelector(".delivery-card"))'), '匯出視窗');
  const measurements = [];
  for (const [width, height] of [[1600,900], [940,760], [800,600], [520,720], [375,812]]) {
    await client.send('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
    await delay(100);
    const result = await client.evaluate(`(${measureDelivery.toString()})()`);
    measurements.push(result);
    await client.evaluate('document.getElementById("modalBody").scrollTop = 0');
    let shot = await client.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(dir, `delivery-${width}-top.png`), Buffer.from(shot.data,'base64'));
    await client.evaluate('document.getElementById("modalBody").scrollTop = document.getElementById("modalBody").scrollHeight');
    shot = await client.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(dir, `delivery-${width}-bottom.png`), Buffer.from(shot.data,'base64'));
  }
  fs.writeFileSync(path.join(dir,'delivery-layout.json'), JSON.stringify(measurements,null,2));
  for (const result of measurements) {
    assert(result.scrollWidth <= result.clientWidth + 1, `${result.width}px 匯出內容不產生橫向捲動`);
    assert.deepEqual(result.horizontalOverflow, [], `${result.width}px 控制項不可超出輸出項目`);
    assert(result.selectText.every(select => select.fits), `${result.width}px 格式、畫面尺寸與影格率完整可讀：${JSON.stringify(result.selectText)}`);
    assert(result.inputHeights.every(height => height === 38), `${result.width}px 規格與檔案輸入高度一致`);
    assert(result.option.aligned && result.option.helpFits, `${result.width}px 書籤勾選與說明對齊`);
    assert.equal(result.option.description, '寫入章節，供支援章節的播放器快速跳轉。');
  }
  await client.evaluate(`(() => {
    const input = document.querySelector('.ev-chapter-notes'); input.click();
    document.getElementById('evAddRowBtn').click();
  })()`);
  assert.equal(await client.evaluate('document.querySelector(".ev-chapter-notes").checked'), true, '新增輸出保留原項目的書籤設定');
  assert.equal(await client.evaluate('new Set([...document.querySelectorAll(".ev-chapter-notes")].map(input=>input.getAttribute("aria-describedby"))).size'), 2, '每個書籤說明各自關聯');
  await client.evaluate('document.querySelector(".ev-del[data-idx=\\"1\\"]").click()');
  const variants = [];
  for (const [format, width, height] of [['airline-dmpes',1600,900], ['bd-iso',1600,900], ['airline-dmpes',901,600], ['bd-iso',375,812], ['h264',375,812]]) {
    await client.send('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
    await client.evaluate(`(() => {
      const select = document.querySelector('.ev-format'); select.value = ${JSON.stringify(format)};
      select.dispatchEvent(new Event('change',{bubbles:true}));
      if (${JSON.stringify(format)} === 'h264') {
        const size = document.querySelector('.ev-res'); size.value = 'custom';
        size.dispatchEvent(new Event('change',{bubbles:true}));
      }
    })()`);
    await delay(100);
    const result = {...await client.evaluate(`(${measureDelivery.toString()})()`),format};
    variants.push(result);
    assert(result.scrollWidth <= result.clientWidth + 1 && !result.horizontalOverflow.length, `${format} ${width}px 所有欄位保留在輸出項目內`);
    assert(result.selectText.every(select => select.fits), `${format} ${width}px 完整選項不得裁字：${JSON.stringify(result.selectText)}`);
    await client.evaluate('document.getElementById("modalBody").scrollTop = 0');
    const shot = await client.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(dir, `delivery-${format}-${width}.png`), Buffer.from(shot.data,'base64'));
  }
  fs.writeFileSync(path.join(dir,'delivery-variants.json'), JSON.stringify(variants,null,2));
  console.log(JSON.stringify({dir,viewports:measurements.map(result => result.width)},null,2));
}

const evidence = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(),'subtool-delivery-ui-')));
captureDocumentationWorkspace(path.join(evidence,'delivery-final.png'), inspectDelivery)
  .catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });

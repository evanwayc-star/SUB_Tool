/* npm run build && node scripts/acceptance/verify-subtitle-list-viewport.js [證據目錄]
   以隔離的 Electron profile 驗證長片搜尋、捲動、跳句、組字與工作區可讀列數。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureDocumentationWorkspace } = require('./capture-documentation-workspace.js');
const { waitFor, delay } = require('./cdp-electron-harness.js');

/* The following functions run in the isolated Chromium renderer. */
/* global document, window, requestAnimationFrame, InputEvent, MouseEvent */
function seed(count) {
  const {State, renderAll, renderListTrackSel, selectCueSingle} = window.SUB;
  document.getElementById('rightPanel').style.width = '570px';
  document.getElementById('timelinePanel').style.height = '280px';
  State.listTrack = 0;
  State.cues = Array.from({length:count}, (_,i) => ({
    id:'line-'+i, track:0, start:i*2, end:i*2+1, text:(i%2?'北站':'南站')+'第'+(i+1)+'句',
  }));
  State.cues.push({id:'translation',track:1,start:0,end:1,text:'另一軌'});
  renderListTrackSel(); renderAll(); selectCueSingle(null,false);
  document.getElementById('sublist').scrollTop=0;
}

function fullRows() {
  const list=document.getElementById('sublist'),box=list.getBoundingClientRect();
  return [...list.querySelectorAll('.sub-row')].filter(row=>{
    const rect=row.getBoundingClientRect();return rect.top>=box.top-.5 && rect.bottom<=box.bottom+.5;
  }).length;
}

async function measureSearch() {
  const input=document.getElementById('searchInput'),list=document.getElementById('sublist');
  const work=[], frames=[];
  for(let i=0;i<12;i++){
    await new Promise(resolve=>requestAnimationFrame(resolve));
    input.value=i%2?'北':'南';
    const start=performance.now();
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:input.value}));
    // Include style and layout. The second callback follows a render opportunity.
    list.getBoundingClientRect(); work.push(performance.now()-start);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    frames.push(performance.now()-start);
  }
  const sorted=values=>values.sort((a,b)=>a-b).map(n=>Math.round(n*10)/10);
  return {syncMs:sorted(work),throughFrameMs:sorted(frames),rows:list.querySelectorAll('.sub-row').length,
    nodes:list.querySelectorAll('*').length,count:document.getElementById('searchCount').textContent};
}

async function inspect(client,dir) {
  const run=(fn,...args)=>client.evaluate('('+fn.toString()+')('+args.map(arg=>JSON.stringify(arg)).join(',')+')');
  const evidence={layout:{},search:{}};
  await run(seed,100);
  for(const [width,height] of [[1440,900],[1280,720],[1024,640]]){
    await client.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await delay(120);
    const unselected=await run(fullRows);
    await client.evaluate("window.SUB.selectCueSingle('line-0',false)");
    await delay(180);
    const selected=await run(fullRows);
    assert(unselected>=3 && selected>=3,'筆電顯示至少三句：'+JSON.stringify({width,height,unselected,selected}));
    evidence.layout[width]={height,unselected,selected};
    await client.evaluate("window.SUB.selectCueSingle(null,false)");
  }
  await client.evaluate("document.querySelector('.style-disclosure').click()");
  assert(await client.evaluate("document.querySelector('.style-expanded .sub-sty').getBoundingClientRect().height>0"));
  await client.evaluate("document.querySelector('.style-disclosure').click()");
  for(const count of [100,1000,3000,10000]){
    await run(seed,count);
    const sample=await run(measureSearch);
    assert.equal(sample.count.split('/')[1],String(count/2));
    assert(sample.rows<64 && sample.nodes<4000,'DOM 節點數跟著視窗而非字幕總數成長');
    evidence.search[count]=sample;
  }
  await client.evaluate("window.SUB.selectCueSingle('translation',false);window.SUB.selectCueSingle('line-9999',false)");
  const isVisible=(id)=>client.evaluate("(()=>{const l=document.querySelector('#sublist').getBoundingClientRect(),r=document.querySelector('[data-id=\""+id+"\"].sub-row')?.getBoundingClientRect();return r&&r.bottom<=l.bottom+1&&r.top>=l.top-1})()");
  await waitFor(()=>isVisible('line-9999'),'跨軌跳最後一句並讀回其位置');
  await delay(200);
  await client.evaluate("document.getElementById('sublist').scrollTop=0");
  await waitFor(()=>isVisible('line-0'),'捲動回第一句');
  await client.evaluate("document.querySelector('.sub-row[data-id=\"line-0\"] .txt').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
  await delay(30);
  await client.evaluate("[...document.querySelectorAll('#modalBg.show #modalFoot button')].find(b=>b.textContent==='稍後再說')?.click()");
  await waitFor(()=>client.evaluate("document.activeElement.matches('.sub-row .txt[contenteditable=true]')"),'進入行內編輯');
  await client.send('Input.imeSetComposition',{text:'測',selectionStart:1,selectionEnd:1});
  await client.evaluate("document.getElementById('sublist').scrollTop=200000;window.SUB.renderSubList()");
  await delay(120);
  assert(await client.evaluate("document.activeElement.closest('.sub-row')?.dataset.id==='line-0' && document.activeElement.textContent.includes('測')"),'組字中的離屏列保持焦點與組字');
  await client.send('Input.insertText',{text:'測試'});
  await client.evaluate('document.activeElement.blur()');
  assert(await client.evaluate("window.SUB.State.cues[0].text.endsWith('測試')"),'讀回組字提交的內容');
  await client.evaluate("document.getElementById('searchInput').value='測試';document.getElementById('searchInput').dispatchEvent(new InputEvent('input',{bubbles:true}));document.getElementById('replaceInput').value='完成';document.querySelector('[data-act=replace-all]').click()");
  assert(await client.evaluate("window.SUB.State.cues[0].text.endsWith('完成') && document.getElementById('searchCount').textContent==='無結果'"),'取代後資料與搜尋索引同步');
  fs.writeFileSync(path.join(dir,'subtitle-list.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence));
}

const dir=path.resolve(process.argv[2]||fs.mkdtempSync(path.join(os.tmpdir(),'subtool-subtitle-list-')));
captureDocumentationWorkspace(path.join(dir,'subtitle-list.png'),inspect)
  .catch(error=>{console.error(error.stack||String(error));process.exitCode=1;});

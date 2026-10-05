/* 字幕樣式篩選與選取規則的 Electron / CDP 真機驗收。
   用法：npm run build，再執行 node scripts/acceptance/verify-subtitle-style-selection.js
   使用獨立暫存 profile；JSON 證據保留於輸出列出的系統 temp 目錄。 */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const H=require('./cdp-electron-harness.js');
const artifact=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-subtitle-selection-'));
const checks=[];
(async()=>{
 const profile=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'subtool-subtitle-rules-cdp-'));
 const port=await H.reservePort();
 const child=H.trackElectron(spawn(H.ELECTRON,['.','--subtool-transport-acceptance',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--no-sandbox','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'],{cwd:H.ROOT,windowsHide:true,stdio:['ignore','ignore','pipe']}));
 let client;const stderr=[];child.stderr.on('data',chunk=>stderr.push(String(chunk)));
 try{
  const target=await H.waitFor(async()=> (await H.getJSON(`http://127.0.0.1:${port}/json/list`)).find(t=>t.type==='page'&&t.title==='SUB TOOL'),'SUB Tool',20000);
  client=new H.CdpClient(target.webSocketDebuggerUrl);await client.connect();await client.send('Page.enable');await client.send('Page.bringToFront');
  await H.waitFor(()=>client.evaluate('Boolean(window.SUB?.SubStyle)'),'SUB public API',15000);
  // 開發模式預設讀 repo .config；acceptance flag 才將設定隔離到 profile。
  // 載入完成後再建立樣式 fixture，避免啟動讀取覆蓋測試中的樣式庫。
  await client.evaluate('window.SUB.SubStyle.loadPresets()');
  const evaluate=expression=>client.evaluate(expression);
  const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const click=async(selector,modifiers=0)=>{
   const rect=await evaluate(`(async()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing '+${JSON.stringify(selector)});el.scrollIntoView({block:'nearest',inline:'nearest'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=el.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,width:b.width,height:b.height,hit:document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)?.closest(${JSON.stringify(selector)})===el};})()`);
   assert.ok(rect.width&&rect.height&&rect.hit,`not hittable ${selector}: ${JSON.stringify(rect)}`);
   await client.send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1,modifiers});
   await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x,y:rect.y,button:'left',clickCount:1,modifiers});await frame();
  };
  const boot=async(expression='')=>{
   await evaluate(`(()=>{const S=window.SUB;document.querySelector('#modalFoot button:last-child')?.click();document.getElementById('searchDialog').style.display='none';document.getElementById('searchInput').value='';document.getElementById('searchInput').dispatchEvent(new Event('input',{bubbles:true}));Object.assign(S.State,{tracks:[{name:'對白',visible:true,locked:false},{name:'另一軌',visible:true,locked:false}],trackCount:2,cues:[{id:'a',text:'match A',track:0,start:1,end:2,timed:true},{id:'b',text:'match B',track:0,start:3,end:4,timed:true},{id:'c',text:'match C',track:0,start:5,end:6,timed:true},{id:'foreign',text:'另一軌',track:1,start:2,end:3,timed:true}],listTrack:0,selectedId:null,selectedIds:[],selectedClipId:null,selectedAudioClipId:null,activeTrackKind:'sub',activeEdge:'start',presetEdit:null,clips:[],notes:[],externalAudioState:[],videoTracks:[{visible:true}],duration:10,fps:25,dropFrame:false,pxPerSec:100,viewStart:0});document.getElementById('subStyleFilter').value='';${expression} S.History.reset();S.renderAll();S.drawTimeline();return true;})()`);await frame();
  };
  const filter=async value=>{await evaluate(`(()=>{const f=document.getElementById('subStyleFilter');f.value=${JSON.stringify(value)};if(f.value!==${JSON.stringify(value)})throw new Error('Filter missing');f.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);await frame();};
  const ctrlA=async()=>{await evaluate('document.activeElement.blur()');await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2});await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2});await frame();};
  const drag=async(selector,dx,modifiers=0)=>{
   const rect=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
   await client.send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1,modifiers});
   await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+dx,y:rect.y,button:'left',buttons:1,modifiers});
   await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+dx,y:rect.y,button:'left',clickCount:1,modifiers});await frame();
  };
  const summary=()=>evaluate(`(()=>{const S=window.SUB;const rows=[...document.querySelectorAll('#sublist .sub-row')];return {ids:rows.map(r=>r.dataset.id),selected:S.State.selectedIds,primary:S.State.selectedId,filter:document.getElementById('subStyleFilter').value,count:document.getElementById('subCount').textContent,labels:rows.map(r=>r.querySelector('.sub-styname')?.textContent),effective:S.State.cues.filter(c=>c.track===0).map(c=>S.SubStyle.effStyle(c,S.State.tracks[0])),overrides:S.State.cues.filter(c=>c.track===0).map(c=>c.style||null),panelSize:document.getElementById('tsSize').value,panelDisabled:document.getElementById('tsSize').disabled};})()`);
  await boot('S.State.cues[0].style={fontSize:99};S.SubStyle.savePresets([]);');
  await click('.sub-row[data-id="a"] .txt');await click('#tsUnify');await click('#modalFoot button:last-child');await H.delay(350);
  await filter('__non_default');let s=await summary();assert.deepEqual(s.ids,['a','b','c']);assert.ok(s.overrides.every(v=>v===null));assert.ok(s.effective.every(v=>v.fontSize===99));assert.ok(s.labels.every(v=>v.includes('自訂')),JSON.stringify(s));assert.equal(s.panelDisabled,true,'篩選取消選取後，樣式面板需同步停用');checks.push({name:'全軌套用非預設：所有繼承字幕完整納入自訂',result:s});
  const screenshot=await client.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifact,'whole-track-custom.png'),Buffer.from(screenshot.data,'base64'));
  const individual=await evaluate(`document.querySelector('#sublist .sub-row .sub-styname').textContent.trim()`);await filter(individual);assert.deepEqual((await summary()).ids,['a','b','c']);checks.push({name:'未命名軌道自訂代碼可單獨篩選',code:individual});
  await boot("S.SubStyle.savePresets([{name:'電影字幕',style:{...S.SubStyle.STYLE_DEFAULTS,fontSize:99}}]);S.State.tracks[0].fontSize=99;");await filter('__non_default');s=await summary();assert.deepEqual(s.ids,['a','b','c']);assert.ok(s.labels.every(v=>v.includes('電影字幕')));checks.push({name:'已命名的非預設整軌仍屬自訂',result:s});
  await boot('S.State.cues[0].style={fontSize:120};S.State.cues[2].style={fontSize:120};');await filter('__non_default');await click('.sub-row[data-id="a"] .txt');await click('.sub-row[data-id="c"] .txt',8);s=await summary();assert.deepEqual(s.selected,['a','c']);assert.equal(s.filter,'__non_default');checks.push({name:'列表 Shift 範圍僅涵蓋當前可見列',result:s});
  await ctrlA();s=await summary();assert.deepEqual(s.selected,['a','c']);assert.equal(s.filter,'__non_default');checks.push({name:'Ctrl+A 僅選取樣式篩選後可見字幕',result:s});
  await click('.sub-row[data-id="c"] .txt');
  await evaluate(`(()=>{window.SUB.showCueMenu(100,100);const entry=[...document.querySelectorAll('#ctxmenu .ci')].find(e=>e.textContent.includes('將以上字幕選取'));entry.dataset.acceptance='range-above';return true;})()`);
  await click('[data-acceptance="range-above"]');s=await summary();assert.deepEqual(s.selected,['a','c']);assert.equal(s.filter,'__non_default');checks.push({name:'右鍵以上範圍也只選取可見列',result:s});
  await boot('S.State.cues[0].style={fontSize:120};');await filter('預設');await click('.sub-row[data-id="b"] .txt');
  await evaluate(`(()=>{document.getElementById('searchDialog').style.display='block';const input=document.getElementById('searchInput');input.value='match';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await click('[data-act="search-select-all"]');s=await summary();assert.deepEqual(s.ids,['a','b','c']);assert.deepEqual(s.selected,['a','b','c']);assert.equal(s.filter,'');checks.push({name:'搜尋全選揭露被樣式篩選隱藏的結果',result:s});
  await boot('S.State.tracks[1].locked=true;');await click('.sub-row[data-id="a"] .txt');const retained=(await summary()).selected;
  await click('.cue-block[data-id="foreign"]');s=await summary();assert.deepEqual(s.selected,retained);checks.push({name:'點擊鎖定軌字幕保留原選取',result:s});
  const rect=await evaluate(`(()=>{const r=document.querySelector('.cue-block[data-id="foreign"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await client.send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1});await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+80,y:rect.y,button:'left',buttons:1});await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+80,y:rect.y,button:'left',clickCount:1});
  s=await summary();assert.deepEqual(s.selected,retained);assert.equal((await evaluate('window.SUB.State.cues.find(c=>c.id==="foreign").start')),2);checks.push({name:'鎖定字幕拖曳僅定位，內容與選取保留',result:s});
  await evaluate('window.SUB.State.listTrack=1;window.SUB.renderSubList()');await ctrlA();assert.deepEqual((await summary()).selected,retained);checks.push({name:'鎖定字幕 Ctrl+A 保留原選取'});
  const lockedRow=await evaluate(`(()=>{const r=document.querySelector('.sub-row[data-id="foreign"] .txt').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await client.send('Input.dispatchMouseEvent',{type:'mousePressed',...lockedRow,button:'left',clickCount:2});await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',...lockedRow,button:'left',clickCount:2});await frame();
  assert.equal(await evaluate('document.querySelector(\'.sub-row[data-id="foreign"] .txt\').contentEditable'),'false');assert.deepEqual((await summary()).selected,retained);checks.push({name:'鎖定字幕雙擊不進入文字編輯'});
  await evaluate(`(async()=>{const pending=window.SUB.setIn();if(document.getElementById('modalTitle').textContent==='開始前先儲存專案')document.querySelector('#modalFoot button:last-child')?.click();await pending;return true;})()`);
  await boot();await click('.cue-block[data-id="a"]');await click('.cue-block[data-id="c"]',2);
  // 50px＝0.5秒；25fps 的最近影格是 0.52秒，群組應共同吸附至影格。
  await drag('.cue-block[data-id="a"]',50);const moved=await evaluate('window.SUB.State.cues.filter(c=>["a","c"].includes(c.id)).map(c=>({id:c.id,start:c.start,end:c.end}))');assert.deepEqual(moved,[{id:'a',start:1.52,end:2.52},{id:'c',start:5.52,end:6.52}]);checks.push({name:'字幕多選群組拖曳保持相對時間',result:moved});
  await boot();await click('.cue-block[data-id="a"]');await click('.cue-block[data-id="c"]',2);await drag('.cue-block[data-id="a"]',50,1);
  const copied=await evaluate('window.SUB.State.cues.map(c=>({id:c.id,start:c.start,end:c.end,track:c.track,text:c.text}))');assert.equal(copied.length,6);assert.equal(copied.find(c=>c.id==='a').start,1);assert.equal(copied.find(c=>c.id==='c').start,5);assert.deepEqual(copied.filter(c=>!["a","b","c","foreign"].includes(c.id)).map(c=>c.start),[1.52,5.52]);checks.push({name:'Alt 多選複製拖曳保留原字幕',result:copied});
  await boot();await click('.sub-row[data-id="a"] .txt');await click('.sub-row[data-id="c"] .txt',2);s=await summary();assert.deepEqual(s.selected,['a','c']);checks.push({name:'Ctrl 多選保留',result:s});
  await evaluate('window.SUB.selectCueSingle(null)');assert.equal((await summary()).primary,null);checks.push({name:'離开末句可明確清除字幕選取'});
  const result={passed:true,checks};fs.writeFileSync(path.join(artifact,'desktop-acceptance.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:true,artifact,checks:checks.map(c=>c.name)},null,2));
 }finally{client?.close();await H.stopElectron(child);H.verifiedCleanup(profile,'subtool-subtitle-rules-cdp-');fs.writeFileSync(path.join(artifact,'desktop-stderr.log'),stderr.join(''));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});

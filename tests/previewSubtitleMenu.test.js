// @subtool-ci windows
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { isMainWindowTarget, ROOT, CdpClient, reservePort, getJSON, waitFor, trackElectron, stopElectron, verifiedCleanup } = require('../scripts/acceptance/cdp-electron-harness.js');
let child, client, profile;

beforeAll(async () => {
  const port = await reservePort();
  profile = mkdtempSync(path.join(tmpdir(), 'subtool-preview-menu-'));
  child = trackElectron(spawn(require('electron'), [
    '.', '--subtool-transport-acceptance', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, '--no-sandbox',
  ], { cwd: ROOT, windowsHide: true, stdio: 'ignore' }));
  const target = await waitFor(async () => (await getJSON(`http://127.0.0.1:${port}/json/list`))
    .find(isMainWindowTarget), '字幕預覽主視窗');
  client = new CdpClient(target.webSocketDebuggerUrl, { timeoutMs: 5000 });
  await client.connect();
  await waitFor(() => client.evaluate('!!window.SUB?.History.stack.length'), '初始化文件基準');
});

afterAll(async () => {
  client?.close();
  if (child) await stopElectron(child);
  if (profile) verifiedCleanup(profile, 'subtool-preview-menu-');
});

async function align(axis, change = null) {
  return client.evaluate(`(() => {
    const {State,History,SubStyle}=window.SUB;
    State.presetEdit=null;
    State.tracks=[{...SubStyle.STYLE_DEFAULTS,name:'original',visible:true,locked:false}];
    State.cues=[{id:'preview-owned',text:'original',track:0,start:0,end:4,style:{posX:12,posY:20}}];
    State.duration=4;State.listTrack=0;History.reset();
    State.cues[0].text='edited';History.record('edit');
    const axis=${JSON.stringify(axis)},change=${JSON.stringify(change)};
    if(change==='preset') State.presetEdit={draft:{posX:12,posY:20}};
    const target=document.createElement('div');target.className='vsub-track';target.dataset.cue='preview-owned';
    document.getElementById('videoSub').appendChild(target);
    target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));
    const original=State.cues[0];
    if(change==='undo') History.undo();
    if(change==='track') State.tracks=[{...State.tracks[0],name:'replacement'}];
    if(change==='lock') State.tracks[0].locked=true;
    if(change==='preset') State.presetEdit={draft:{posX:31,posY:41}};
    const menu=document.getElementById('ctxmenu');
    const item=[...menu.querySelectorAll('.ci')].find(item=>item.textContent.includes(axis==='x'?'水平置中':'垂直置中'));
    const visible=menu.classList.contains('show')&&item?.isConnected;
    const replacement=State.cues[0],history=History.stack.length;
    const before=State.presetEdit ? {...State.presetEdit.draft} : SubStyle.effStyle(replacement,State.tracks[0]);
    item.click();
    const after=State.presetEdit ? {...State.presetEdit.draft} : SubStyle.effStyle(replacement,State.tracks[0]);
    return {visible,replaced:replacement!==original,before:{posX:before.posX,posY:before.posY},after:{posX:after.posX,posY:after.posY},historyBefore:history,historyAfter:History.stack.length};
  })()`);
}

describe('字幕預覽置中選單的文件所有權', () => {
  it.each(['x', 'y'])('正常 %s 置中只改目標座標，並可一次 Undo', async axis => {
    const result = await align(axis);
    expect(result.visible).toBe(true);
    expect(result.after).toEqual(axis === 'x' ? { posX: 50, posY: 20 } : { posX: 12, posY: 50 });
    expect(result.historyAfter).toBe(result.historyBefore + 1);
    const restored = await client.evaluate(`(() => {const {State,History,SubStyle}=window.SUB;History.undo();const style=SubStyle.effStyle(State.cues[0],State.tracks[0]);return {posX:style.posX,posY:style.posY};})()`);
    expect(restored).toEqual({ posX: 12, posY: 20 });
  });

  it.each(['x', 'y'])('Undo 重建同 ID 字幕後，舊 %s 選單不修改新物件', async axis => {
    const result = await align(axis, 'undo');
    expect(result.visible).toBe(true);
    expect(result.replaced).toBe(true);
    expect(result.after).toEqual(result.before);
    expect(result.historyAfter).toBe(result.historyBefore);
  });

  it.each(['track', 'lock', 'preset'])('%s 改變後拒絕舊字幕預覽選單', async change => {
    const result = await align('x', change);
    expect(result.visible).toBe(true);
    expect(result.after).toEqual(result.before);
    expect(result.historyAfter).toBe(result.historyBefore);
  });
});

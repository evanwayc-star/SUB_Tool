'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { parse } = require('acorn');
const { createDirectoryOutputRuntime } = require('../../electron/directory-output');
const { fileCommitCoordinator } = require('../../electron/file-commit-coordinator');

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-directory-lifecycle-'));
process.env.SUBTOOL_DIRECTORY_LIFECYCLE_GATE = root;
const runtime = createDirectoryOutputRuntime({ coordinator:fileCommitCoordinator });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待測試條件逾時');
    await sleep(10);
  }
}
function write(label) { return runtime.write(root, [{name:'shared.json',b64:Buffer.from(label).toString('base64')}]); }
function release(label) { fs.writeFileSync(path.join(root,`release-${label}`), 'go'); }
function ready(label) { return fs.existsSync(path.join(root,`ready-${label}`)); }

async function main() {
  const scenario = process.argv[2];
  try {
    if (scenario === 'worker-error') {
      const failed = write('failed');
      const retry = write('retry');
      await assert.rejects(failed, /injected worker failure/);
      await until(() => ready('retry'));
      release('retry');
      assert.equal((await retry).written, 1);
      assert.equal(fs.readFileSync(path.join(root,'shared.json'),'utf8'), 'retry');
      return;
    }
    const first = write('first');
    await until(() => ready('first'));
    const second = write('second');
    const source = fs.readFileSync(path.join(process.cwd(),'electron/main.js'),'utf8');
    const tree = parse(source,{ecmaVersion:'latest',sourceType:'script'});
    const node = tree.body.find(item => item.expression?.callee?.object?.name === 'app'
      && item.expression.callee.property?.name === 'on' && item.expression.arguments[0]?.value === 'before-quit');
    let handler, quitCount = 0, dialogCount = 0, meterStops = 0;
    const idle = {cancelAllAndWait:async()=>{},resume:async()=>{}};
    const context = {
      app:{on:(_event,fn)=>{handler=fn;},quit:()=>{quitCount++;}},
      _quitReady:false,_quitSequenceStarted:false,_isAppQuitting:false,
      audioNormalizationJobs:new Map(),mediaProbe:scenario==='failure'?{...idle,cancelAllAndWait:async()=>{throw new Error('shutdown failed');}}:idle,
      ffmpegExecution:idle,deliveryCapabilities:idle,speechCompressionRuntime:idle,speechAudioReader:idle,vocalWaveformRuntime:idle,
      nativeAudioMeter:{stop:async()=>{meterStops++;}},
      mediaIngestCoordinator:idle,mediaWaveformCoordinator:idle,directoryOutput:runtime,
      QueueManager:{prepareForShutdown:async()=>{},cancelShutdown:async()=>{}},
      clipAudioCache:{waitForIdle:async()=>{}},clipFrameCache:{waitForIdle:async()=>{}},
      screenshotOutput:{close:async()=>{},resume:async()=>{}},fileCommitCoordinator:require('../../electron/file-commit-coordinator').fileCommitCoordinator,mpvHost:{disposeAndWait:async()=>{},resume:async()=>{}},
      mediaIntakeRuntime:{close:async()=>{},resume:async()=>{}},mainWin:null,
      dialog:{showMessageBox:async()=>{dialogCount++;}},console:{error:()=>{}},
    };
    vm.runInNewContext(source.slice(node.start,node.end),context);
    let prevented = false;
    handler({preventDefault:()=>{prevented=true;}});
    await sleep(100);
    assert.equal(prevented,true);
    assert.equal(meterStops,1);
    assert.equal(quitCount,0);
    assert.equal(context._isAppQuitting,true);
    await assert.rejects(write('too-early'), /正在關閉/);
    release('first');
    await first;
    await until(()=>ready('second'));
    assert.equal(quitCount,0);
    assert.equal(context._isAppQuitting,true);
    await assert.rejects(write('still-early'), /正在關閉/);
    release('second');
    await second;
    if (scenario === 'failure') {
      await until(()=>dialogCount===1);
      assert.equal(context._isAppQuitting,false);
      const retry=write('after-resume');
      await until(()=>ready('after-resume'));
      release('after-resume');
      assert.equal((await retry).written,1);
      assert.equal(fs.readFileSync(path.join(root,'shared.json'),'utf8'),'after-resume');
      assert.equal(quitCount,0);
    } else {
      await until(()=>quitCount===1);
      assert.equal(fs.readFileSync(path.join(root,'shared.json'),'utf8'),'second');
    }
  } finally {
    for (const label of ['first','second','retry','after-resume']) release(label);
    await runtime.close();
    const actual=fs.realpathSync(root);
    if(path.dirname(actual)!==fs.realpathSync(os.tmpdir()) || !path.basename(actual).startsWith('subtool-directory-lifecycle-'))
      throw new Error('拒絕清理測試目錄外路徑');
    fs.rmSync(actual,{recursive:true,force:true});
  }
}
main().catch(error=>{process.stderr.write(error.stack||String(error));process.exitCode=1;});

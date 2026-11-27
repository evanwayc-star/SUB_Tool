// Run with node scripts/acceptance/verify-speech-credentials.js on a desktop
// with an unlocked OS keystore. Each phase boots a fresh, isolated Electron.
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifiedCleanup } = require('./cdp-electron-harness');

const prefix = 'subtool-speech-credentials-';
const testValue = 'synthetic-acceptance-credential';

async function checkPhase(app, safeStorage, profile, phase) {
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.commandLine.appendSwitch('disable-background-networking');
  await app.whenReady();
  const { createSpeechCloud } = require('../../electron/speech-cloud');
  const config = path.join(profile, 'settings');
  let requests = 0;
  const cloud = createSpeechCloud({
    configDir: () => config,
    safeStorage,
    request: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(init.headers.Authorization, 'Bearer ' + testValue);
      requests++;
      return new Response('accepted');
    }
  });
  if (phase === 'save') {
    assert.equal((await cloud.status()).openai, false);
    await cloud.save({ openai: testValue });
  }
  assert.equal((await cloud.status()).openai, true);
  const stored = fs.readFileSync(path.join(config, 'speech-credentials.json'), 'utf8');
  assert.equal(stored.includes(testValue), false);
  assert.ok(Buffer.from(JSON.parse(stored).openai, 'base64').length > 0);
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
  const response = await cloud.send(sender, {
    id: 'test', provider: 'openai', url: 'https://api.openai.com/v1/audio/transcriptions',
    method: 'POST', contentType: 'application/json', body: new TextEncoder().encode('{}')
  });
  assert.equal(response.text, 'accepted');
  assert.equal(requests, 1);
  fs.writeFileSync(path.join(profile, phase + '.json'), JSON.stringify({
    phase, electron: process.versions.electron, encrypted: true, authenticated: true
  }));
}

function runAcceptance() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    for (const phase of ['save', 'reopen']) {
      const child = spawnSync(require('electron'), [
        __filename, '--user-data-dir=' + profile, '--speech-vault-phase=' + phase
      ], { encoding: 'utf8', env, timeout: 30000, windowsHide: true });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error('Electron ' + phase + ' failed. ' + child.stderr);
      const result = JSON.parse(fs.readFileSync(path.join(profile, phase + '.json'), 'utf8'));
      console.log(JSON.stringify(result));
    }
  } finally {
    verifiedCleanup(profile, prefix);
  }
}

if (process.versions.electron) {
  const { app, safeStorage } = require('electron');
  const profile = app.commandLine.getSwitchValue('user-data-dir');
  const phase = app.commandLine.getSwitchValue('speech-vault-phase');
  const resolved = fs.realpathSync.native(profile);
  assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith(prefix));
  assert.ok(['save', 'reopen'].includes(phase));
  checkPhase(app, safeStorage, resolved, phase).then(() => app.quit(), error => {
    console.error(error);
    app.exit(1);
  });
} else {
  runAcceptance();
}

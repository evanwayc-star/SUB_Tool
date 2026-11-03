import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createSpeechAudioCompressor } = require('../electron/speech-audio-compressor.js');
const { createMediaIntakeRuntime } = require('../electron/media-intake-runtime.js');
const { FileAuthority } = require('../electron/file-authority.js');
const roots = [];
function wav() {
  const value = Buffer.alloc(364);
  value.write('RIFF',0); value.writeUInt32LE(value.length-8,4); value.write('WAVEfmt ',8);
  value.writeUInt32LE(16,16); value.writeUInt16LE(1,20); value.writeUInt16LE(1,22);
  value.writeUInt32LE(16000,24); value.writeUInt32LE(32000,28); value.writeUInt16LE(2,32);
  value.writeUInt16LE(16,34); value.write('data',36); value.writeUInt32LE(320,40);
  return value;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const real = fs.realpathSync(root);
    if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith('subtool-speech-immutable-'))
      throw new Error('拒絕清理測試目錄之外的資料');
    fs.rmSync(real, { recursive:true, force:true });
  }
});

it('讀取時原位改寫又還原，實際轉檔輸入仍必須是原始凍結音訊', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subtool-speech-immutable-')); roots.push(root);
  const input = path.join(root,'input.wav'), output = path.join(root,'output.mp3');
  const intake = createMediaIntakeRuntime({ tempRoot:root, cacheRoot:path.join(root,'cache'), allowSidecarCache:false,
    fileAuthority:new FileAuthority({ internalDirectories:[root] }), ffmpegExecution:{ execute:async()=>{} } });
  let observed;
  const compressor = createSpeechAudioCompressor({
    createTempPath:ext=>ext==='wav'?input:output,
    produceTemporaryFile:(file,work)=>intake.produceTemporaryFile(file,work),
    withTemporaryDescriptor:(file,owner,work)=>intake.withTemporaryDescriptor(file,owner,work),
    cleanupGeneratedFile:file=>intake.cleanupGeneratedFile(file),
    execute:async(_args, options)=>{
      if (fs.existsSync(input)) {
        const file = fs.openSync(input,'r+');
        try {
          fs.writeSync(file,Buffer.from([73]),0,1,44);
          const sample=Buffer.alloc(1); fs.readSync(options.inputDescriptor,sample,0,1,44); observed=sample[0];
          fs.writeSync(file,Buffer.from([0]),0,1,44);
        } finally { fs.closeSync(file); }
      } else observed = options.inputBytes?.[44];
      fs.writeSync(options.outputDescriptor,Buffer.from(`encoded:${observed}`));
    },
  });
  const result = await compressor.compress(wav());
  expect(observed).toBe(0);
  expect(Buffer.from(result.b64,'base64').toString()).toBe('encoded:0');
});

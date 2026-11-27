import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createScreenTextSettings, validateScreenTextOptions } = require('../electron/screen-text-settings');
const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(env = {}) {
  const configDir = mkdtempSync(path.join(tmpdir(), 'subtool-vision-settings-'));
  directories.push(configDir);
  // A reversible test cipher proves that no plaintext travels through the
  // persistence/renderer boundary; Electron owns real OS encryption.
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: key => Buffer.from([...key].reverse().join('')),
    decryptString: bytes => [...bytes.toString()].reverse().join(''),
  };
  return { configDir, safeStorage, store: createScreenTextSettings({ configDir, safeStorage, env }) };
}

describe('畫面辨識私有設定', () => {
  it('新設定與直接工作預設使用最高解析度、取樣率與旗艦，遷移記號不離開設定檔', () => {
    const { store } = fixture();
    const expected = { provider:'openai', model:'gpt-5.4', sourceLang:'auto', sampleFps:10,
      frameWidth:1920, smartAccuracy:true };
    expect(store.get()).toEqual({ ...expected, hasApiKey:{ openai:false, gemini:false } });
    expect(validateScreenTextOptions({ qualityDefaultsVersion:999 })).toEqual(expected);
    expect(validateScreenTextOptions({ provider:'gemini' }).model).toBe('gemini-2.5-pro');
  });

  it.each([
    ['openai', 'gpt-5.4-mini', 'gpt-5.4'],
    ['gemini', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    ['openai', 'my-private-vision-model', 'my-private-vision-model'],
  ])('一次遷移 %s 舊設定，保留語言與加密金鑰，之後允許手動降檔', (provider, model, expectedModel) => {
    const { store, configDir, safeStorage } = fixture();
    const file = path.join(configDir, 'screen-text-settings.json');
    const encryptedKeys = { openai:safeStorage.encryptString('old-private-key').toString('base64'),
      gemini:safeStorage.encryptString('old-gemini-key').toString('base64') };
    writeFileSync(file, JSON.stringify({ provider, model, sourceLang:'ko', sampleFps:0.5,
      frameWidth:960, smartAccuracy:false, encryptedKeys }));
    expect(store.get()).toEqual({ provider, model:expectedModel, sourceLang:'ko', sampleFps:10,
      frameWidth:1920, smartAccuracy:true, hasApiKey:{ openai:true, gemini:true } });
    const migrated = JSON.parse(readFileSync(file, 'utf8'));
    expect(migrated.encryptedKeys).toEqual(encryptedKeys);
    expect(migrated.qualityDefaultsVersion).toBe(1);
    expect(store.apiKey('openai')).toBe('old-private-key');
    const saved = store.save({ provider, model, sourceLang:'ja', sampleFps:2, frameWidth:1280, smartAccuracy:false });
    const reopened = createScreenTextSettings({ configDir, safeStorage, env:{} });
    expect(reopened.get()).toEqual(saved);
    expect(reopened.get()).toMatchObject({ model, sourceLang:'ja', sampleFps:2, frameWidth:1280, smartAccuracy:false });
    expect(JSON.parse(readFileSync(file, 'utf8')).encryptedKeys).toEqual(encryptedKeys);
  });

  it('雙供應商金鑰加密持久化，只回傳就緒狀態，非機密設定可讀回', () => {
    const { store, configDir } = fixture();
    expect(store.get().hasApiKey).toEqual({ openai: false, gemini: false });
    const first = store.save({ provider: 'openai', apiKey: 'openai-private-key', sourceLang: 'ko' });
    expect(first.hasApiKey).toEqual({ openai: true, gemini: false });
    store.save({ provider: 'gemini', apiKey: 'gemini-private-key' });
    const last = store.save({ provider: 'openai', sourceLang: 'ja', apiKey: '' });
    expect(last.sourceLang).toBe('ja');
    expect(last.hasApiKey).toEqual({ openai: true, gemini: true });
    expect(store.apiKey('openai')).toBe('openai-private-key');
    expect(store.apiKey('gemini')).toBe('gemini-private-key');
    const text = readFileSync(path.join(configDir, 'screen-text-settings.json'), 'utf8');
    expect(text).not.toContain('openai-private-key');
    expect(text).not.toContain('gemini-private-key');
    expect(JSON.stringify(last)).not.toMatch(/private-key|encryptedKeys|apiKey"/);
  });

  it('環境變數只作fallback，加密金鑰優先，絕不把環境變數寫入設定', () => {
    const { store, configDir } = fixture({ OPENAI_API_KEY: 'env-secret', GEMINI_API_KEY: 'env-gemini' });
    expect(store.get().hasApiKey).toEqual({ openai: true, gemini: true });
    expect(store.apiKey('openai')).toBe('env-secret');
    store.save({ apiKey: 'saved-secret' });
    expect(store.apiKey('openai')).toBe('saved-secret');
    expect(readFileSync(path.join(configDir, 'screen-text-settings.json'), 'utf8')).not.toContain('env-secret');
  });

  it('系統加密不可用或只有明文backend時拒絕儲存金鑰', () => {
    const { store, safeStorage } = fixture();
    safeStorage.isEncryptionAvailable = () => false;
    expect(() => store.save({ apiKey: 'secret' })).toThrow('安全儲存');
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.getSelectedStorageBackend = () => 'basic_text';
    expect(() => store.save({ apiKey: 'secret' })).toThrow('安全儲存');
  });

  it('未知欄位不落盤，非法設定不破壞已存金鑰', () => {
    const { store, configDir } = fixture();
    store.save({ apiKey: 'original-secret', outputDir: 'foreign', ffmpeg: 'foreign' });
    expect(() => store.save({ sourceLang: 'unknown', apiKey: 'replacement' })).toThrow();
    expect(store.apiKey('openai')).toBe('original-secret');
    expect(readFileSync(path.join(configDir, 'screen-text-settings.json'), 'utf8')).not.toContain('foreign');
  });
});

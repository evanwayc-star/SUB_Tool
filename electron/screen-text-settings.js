'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSettingsFile } = require('./settings-file');
const { SCREEN_TEXT_MODELS, SCREEN_TEXT_DEFAULT_MODELS: DEFAULT_MODELS,
  SCREEN_TEXT_DEFAULTS: DEFAULTS } = require('../shared/screen-text-options.cjs');

const QUALITY_DEFAULTS_VERSION = 2;
const retiredGemini = new Map([['gemini-2.5-flash', 'gemini-3.5-flash-lite'], ['gemini-2.5-pro', 'gemini-3.8-flash']]);

function validateScreenTextOptions(input = {}) {
  const { provider = DEFAULTS.provider, sourceLang = DEFAULTS.sourceLang, sampleFps = DEFAULTS.sampleFps,
    frameWidth = DEFAULTS.frameWidth, smartAccuracy = DEFAULTS.smartAccuracy } = input;
  if (!Object.hasOwn(DEFAULT_MODELS, provider)) throw new Error('請選擇 OpenAI 或 Google Gemini');
  const model = input.model ?? DEFAULT_MODELS[provider];
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) throw new Error('請輸入有效的視覺模型名稱');
  if (!['auto', 'ko', 'ja', 'zh', 'en'].includes(sourceLang)) throw new Error('請選擇有效的來源語言');
  if (!Number.isFinite(sampleFps) || sampleFps < 0.1 || sampleFps > 10) throw new Error('每秒取樣數必須介於 0.1 與 10');
  if (![960, 1024, 1280, 1440, 1920].includes(frameWidth)) throw new Error('請選擇有效的畫面寬度');
  if (typeof smartAccuracy !== 'boolean') throw new Error('智慧精準強化設定無效');
  const options = { provider, model, sourceLang, sampleFps, frameWidth, smartAccuracy };
  if (input.contentMode !== undefined) {
    if (!['faithful', 'variety'].includes(input.contentMode)) throw new Error('畫面文字保留方式無效');
    options.contentMode = input.contentMode;
  }
  if (input.region != null) {
    const { x, y, width, height } = input.region;
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 ||
        width <= 0 || height <= 0 || x + width > 1 || y + height > 1) throw new Error('辨識區域必須位於畫面內');
    options.region = { x, y, width, height };
  }
  return options;
}

function createScreenTextSettings({ configDir, safeStorage, env = process.env }) {
  const directory = () => typeof configDir === 'function' ? configDir() : configDir;
  const file = createSettingsFile({ filePath: () => path.join(directory(), 'screen-text-settings.json') });
  const envKey = provider => provider === 'openai' ? env.OPENAI_API_KEY : (env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
  const encryptionAvailable = () => safeStorage.isEncryptionAvailable()
    && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';

  function apiKey(provider, data = file.read()) {
    if (!Object.hasOwn(DEFAULT_MODELS, provider)) throw new Error('辨識供應商無效');
    const encrypted = data.encryptedKeys?.[provider];
    if (encrypted) {
      if (!encryptionAvailable()) throw new Error('系統金鑰保護尚未就緒，無法讀取畫面辨識金鑰');
      try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
      catch { throw new Error('無法解密畫面辨識金鑰，請在目前電腦重新儲存'); }
    }
    return typeof envKey(provider) === 'string' ? envKey(provider).trim() : '';
  }

  function readSettings() {
    const data = file.read();
    if (Number.isInteger(data.qualityDefaultsVersion) && data.qualityDefaultsVersion >= QUALITY_DEFAULTS_VERSION) return data;
    fs.mkdirSync(directory(), { recursive: true });
    return file.update(current => {
      if (Number.isInteger(current.qualityDefaultsVersion) && current.qualityDefaultsVersion >= QUALITY_DEFAULTS_VERSION) return current;
      const provider = current.provider ?? DEFAULTS.provider;
      const currentQuality = current.qualityDefaultsVersion === 1;
      const builtIn = Object.values(SCREEN_TEXT_MODELS).some(models => models.includes(current.model)) || retiredGemini.has(current.model);
      let model = current.model;
      if (currentQuality && provider === 'gemini') model = retiredGemini.get(model) ?? model;
      if (!currentQuality && (model == null || builtIn)) model = DEFAULT_MODELS[provider];
      const options = validateScreenTextOptions({ ...current, model,
        ...(!currentQuality && {sampleFps:DEFAULTS.sampleFps, frameWidth:DEFAULTS.frameWidth, smartAccuracy:DEFAULTS.smartAccuracy}) });
      return { ...options, qualityDefaultsVersion: QUALITY_DEFAULTS_VERSION, encryptedKeys: { ...current.encryptedKeys } };
    });
  }

  function publicSettings(data = readSettings()) {
    const hasApiKey = {};
    for (const provider of Object.keys(DEFAULT_MODELS)) {
      try { hasApiKey[provider] = !!apiKey(provider, data); }
      catch { hasApiKey[provider] = false; }
    }
    return { ...validateScreenTextOptions(data), hasApiKey };
  }

  function save(input) {
    const options = validateScreenTextOptions(input);
    let encrypted;
    if (input.apiKey !== undefined && input.apiKey !== '') {
      if (typeof input.apiKey !== 'string' || !/^[!-~]{1,4096}$/.test(input.apiKey.trim())) throw new Error('API 金鑰格式無效');
      if (!encryptionAvailable()) throw new Error('系統金鑰保護尚未就緒，無法安全儲存 API 金鑰');
      encrypted = safeStorage.encryptString(input.apiKey.trim()).toString('base64');
    }
    fs.mkdirSync(directory(), { recursive: true });
    const saved = file.update(current => ({ ...options, qualityDefaultsVersion: QUALITY_DEFAULTS_VERSION, encryptedKeys: {
      ...current.encryptedKeys, ...(encrypted ? { [options.provider]: encrypted } : {}),
    } }));
    return publicSettings(saved);
  }

  return { get: publicSettings, save, apiKey };
}

module.exports = { createScreenTextSettings, validateScreenTextOptions };

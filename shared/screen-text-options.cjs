'use strict';

const SCREEN_TEXT_MODELS = Object.freeze({
  openai: Object.freeze(['gpt-5.4-mini', 'gpt-5.4']),
  gemini: Object.freeze(['gemini-3.5-flash-lite', 'gemini-3.8-flash']),
});
const SCREEN_TEXT_DEFAULT_MODELS = Object.freeze({ openai: 'gpt-5.4', gemini: 'gemini-3.8-flash' });
const SCREEN_TEXT_DEFAULTS = Object.freeze({
  provider: 'openai', model: SCREEN_TEXT_DEFAULT_MODELS.openai, sourceLang: 'auto',
  sampleFps: 10, frameWidth: 1920, smartAccuracy: true,
});

// These model IDs are installed with the desktop application. Empty selection
// enables the broader automatic script detection in the local frame worker.
const FRAME_TEXT_LANGUAGES = Object.freeze({
  chi_tra:'繁中', chi_sim:'簡中', eng:'英文', jpn:'日文', kor:'韓文', tha:'泰文',
  fra:'法文', deu:'德文', spa:'西班牙文', rus:'俄文', ara:'阿拉伯文', hin:'印地文', ell:'希臘文', heb:'希伯來文',
});

module.exports = { SCREEN_TEXT_MODELS, SCREEN_TEXT_DEFAULT_MODELS, SCREEN_TEXT_DEFAULTS, FRAME_TEXT_LANGUAGES };

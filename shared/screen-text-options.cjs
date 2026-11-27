'use strict';

const SCREEN_TEXT_MODELS = Object.freeze({
  openai: Object.freeze(['gpt-5.4-mini', 'gpt-5.4']),
  gemini: Object.freeze(['gemini-2.5-flash', 'gemini-2.5-pro']),
});
const SCREEN_TEXT_DEFAULT_MODELS = Object.freeze({ openai: 'gpt-5.4', gemini: 'gemini-2.5-pro' });
const SCREEN_TEXT_DEFAULTS = Object.freeze({
  provider: 'openai', model: SCREEN_TEXT_DEFAULT_MODELS.openai, sourceLang: 'auto',
  sampleFps: 10, frameWidth: 1920, smartAccuracy: true,
});

module.exports = { SCREEN_TEXT_MODELS, SCREEN_TEXT_DEFAULT_MODELS, SCREEN_TEXT_DEFAULTS };

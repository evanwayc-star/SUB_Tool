/* 供應者可接受的導引資料：設定視窗與辨識工作共用的純規則。 */
export const CLOUD_PROVIDER_META = Object.freeze({
  google: Object.freeze({ keyField: 'googleApiKey', name: 'Google Gemini', keyLabel: 'Google Gemini API Key：', helpLabel: '取得 Google 免費 API Key ↗', helpURL: 'https://aistudio.google.com/app/apikey' }),
  azure: Object.freeze({ keyField: 'azureApiKey', name: 'Azure Speech', keyLabel: 'Azure Speech API Key：', helpLabel: '建立 Azure Speech 資源 ↗', helpURL: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices' }),
  groq: Object.freeze({ keyField: 'groqApiKey', name: 'Groq', keyLabel: 'Groq API Key：', helpLabel: '取得 Groq 免費 API Key ↗', helpURL: 'https://console.groq.com/keys' }),
  openai: Object.freeze({ keyField: 'openaiApiKey', name: 'OpenAI', keyLabel: 'OpenAI API Key：', helpLabel: '取得 OpenAI API Key ↗', helpURL: 'https://platform.openai.com/api-keys' }),
  elevenlabs: Object.freeze({ keyField: 'elevenlabsApiKey', name: 'ElevenLabs', keyLabel: 'ElevenLabs API Key：', helpLabel: '取得 ElevenLabs API Key ↗', helpURL: 'https://elevenlabs.io/app/settings/api-keys' })
});

const ASR_GUIDANCE_META = Object.freeze({
  builtin: Object.freeze({ kind: 'prompt', label: '前文／專有名詞導引（Prompt）：', placeholder: '選填，例如：以下為繁體中文對話，包含專有名詞…' }),
  google: Object.freeze({ kind: 'prompt', label: '提示詞（Prompt）：', placeholder: '選填，例如：逐字轉錄並保留標點符號。' }),
  azure: Object.freeze({ kind: 'phrases', label: 'Azure 專有名詞（Phrase List，以逗號分隔）：', placeholder: '選填，例如：SUB Tool, Evan' }),
  groq: Object.freeze({ kind: 'prompt', label: '前文／專有名詞導引（Prompt）：', placeholder: '選填，例如：China Airlines, EES, Kiosk' }),
  openai: Object.freeze({ kind: 'prompt', label: '前文／專有名詞導引（Prompt）：', placeholder: '選填，例如：China Airlines, EES, Kiosk' }),
  elevenlabs: Object.freeze({ kind: 'keyterms', label: '專有名詞導引（Keyterms，以逗號分隔）：', placeholder: '選填，例如：SUB Tool, Evan, Scribe' })
});

export function getAsrGuidanceMeta(provider) { return ASR_GUIDANCE_META[provider] || null; }

export function resolveAsrGuidance(provider, rawValue = '') {
  const meta = getAsrGuidanceMeta(provider);
  const value = typeof rawValue === 'string' ? rawValue : '';
  if (!meta) return {};
  if (meta.kind === 'phrases') return {
    azurePhraseList: value,
    azurePhrases: value.split(/[,，;；\n]+/u).map(item => item.trim()).filter(Boolean)
  };
  if (meta.kind === 'keyterms') return {
    elevenlabsKeytermsText: value,
    keyterms: value.split(/[,，;；\n]+/u).map(item => item.trim()).filter(Boolean)
  };
  return { prompt: value };
}


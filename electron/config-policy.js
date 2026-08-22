/* ==============================================================================
   SUB Tool — 設定白名單合併策略 (Configuration Allowlist Merge Policy)
   ==============================================================================
   【架構與職責】
   處理主行程受控之設定（settings.json）與渲染端傳來之設定補丁的安全合併。
   
   【安全鐵律】
   settings.json 同時包含主行程私有安全狀態（如最近開啟專案清單 recentProjects）。
   渲染端的設定更新必須採「嚴格白名單屬性覆蓋」，禁止任意深層物件覆寫，
   防止惡意建構的路徑偽造成受信任專案記錄。
   ============================================================================== */
'use strict';

/** 允許由渲染端更新之布林開關設定鍵名 */
const BOOLEAN_KEYS = Object.freeze([
  'autoSelect',
  'overwriteMode',
  'overwriteKeep',
  'safeFrame',
  'timecodeWatermark',
]);

/**
 * 依據安全白名單將渲染端設定安全合併進現有設定中。
 * 
 * @param {object} [current] 目前主行程儲存之完整設定物件
 * @param {object} [incoming] 渲染端請求更新之設定補丁
 * @returns {object} 合併後之安全新設定物件
 */
function mergeRendererConfig(current, incoming) {
  const next = current && typeof current === 'object' && !Array.isArray(current)
    ? { ...current }
    : {};
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return next;
  }

  for (const key of BOOLEAN_KEYS) {
    if (typeof incoming[key] === 'boolean') {
      next[key] = incoming[key];
    }
  }
  if (Array.isArray(incoming.subPresets)) {
    next.subPresets = incoming.subPresets;
  }
  return next;
}

module.exports = { BOOLEAN_KEYS, mergeRendererConfig };

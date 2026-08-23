/* ==============================================================================
   SUB Tool — Keybinding Adapter
   ==============================================================================
   核心實作已深化至 src/keybinding-engine.js。
   ============================================================================== */
export {
  isNumpadCode,
  bindFromEvent,
  sameBind,
  findConflict,
  formatBind,
  matchAction,
  mergeImportedKeymap,
  stripEmptyBinds,
} from './keybinding-engine.js';

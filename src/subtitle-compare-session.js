/* ==============================================================================
   SUB Tool — Subtitle Compare Session Adapter
   ==============================================================================
   核心實作已深化至 src/subtitle-comparison-engine.js。
   ============================================================================== */
export { buildSubtitleComparisonPlan } from './subtitle-comparison.js';
export {
  createSubtitleCompareSession,
  configureSubtitleCompareSession,
  openSubtitleCompareSession,
  syncSubtitleCompareSession,
  closeSubtitleCompareSession,
  handleSubtitleCompareCommand,
} from './subtitle-comparison-engine.js';

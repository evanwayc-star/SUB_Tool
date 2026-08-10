'use strict';

/* settings.json also contains main-process-owned security state such as the
   recent-project list.  Renderer settings are an allowlisted patch, never a
   generic object merge, otherwise config:save can manufacture a path that a
   later openRecentProject call treats as trusted. */
const BOOLEAN_KEYS = Object.freeze([
  'autoSelect',
  'overwriteMode',
  'overwriteKeep',
  'safeFrame',
  'timecodeWatermark',
]);

function mergeRendererConfig(current, incoming) {
  const next = current && typeof current === 'object' && !Array.isArray(current)
    ? { ...current }
    : {};
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return next;

  for (const key of BOOLEAN_KEYS) {
    if (typeof incoming[key] === 'boolean') next[key] = incoming[key];
  }
  if (Array.isArray(incoming.subPresets)) next.subPresets = incoming.subPresets;
  return next;
}

module.exports = { BOOLEAN_KEYS, mergeRendererConfig };

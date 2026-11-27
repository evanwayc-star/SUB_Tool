// Each editing session owns one atomic record, including two tabs editing files with the same name.
export const DRAFT_PREFIX = 'subtool_project_draft_';
const LEGACY_DATA = 'subtool_autosave_data';
const LEGACY_NAME = 'subtool_autosave_name';

export function saveBrowserDraft(storage, id, record) {
  storage.setItem(DRAFT_PREFIX + id, JSON.stringify(record));
}

export function listBrowserDrafts(storage) {
  const drafts = [];
  const payload = storage.getItem(LEGACY_DATA);
  if (payload) {
    const legacy = { key: LEGACY_DATA, name: storage.getItem(LEGACY_NAME) || '舊版備份.subtool', payload };
    // Keep the original bytes until the new record has been read back. A full
    // store can still restore/download the legacy entry without copying it.
    try {
      const key = DRAFT_PREFIX + 'legacy';
      if (storage.getItem(key) === null) saveBrowserDraft(storage, 'legacy', { name: legacy.name, payload, savedAt: 0 });
      const migrated = JSON.parse(storage.getItem(key));
      if (migrated?.payload === payload && migrated.name === legacy.name) removeBrowserDraft(storage, legacy);
      else drafts.push(legacy);
    } catch { drafts.push(legacy); }
  }
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(DRAFT_PREFIX)) continue;
    try {
      const record = JSON.parse(storage.getItem(key));
      if (record && typeof record.name === 'string' && typeof record.payload === 'string')
        drafts.push({ ...record, key });
    } catch { /* Another tab can remove an entry during enumeration. */ }
  }
  drafts.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return drafts;
}

export function removeBrowserDraft(storage, draft) {
  if (draft.key === LEGACY_DATA) {
    if (storage.getItem(LEGACY_DATA) !== draft.payload) return false;
    storage.removeItem(LEGACY_DATA);
    storage.removeItem(LEGACY_NAME);
  } else if (draft.key.startsWith(DRAFT_PREFIX)) {
    const current = JSON.parse(storage.getItem(draft.key));
    if (!current || current.payload !== draft.payload || current.savedAt !== draft.savedAt) return false;
    storage.removeItem(draft.key);
  }
  return true;
}

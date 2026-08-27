/* ==============================================================================
   SUB Tool — 專案工作區快照與版本正規化

   這是 .subtool 純資料的唯一權威：建立目前格式、把歷史格式整理成
   Project.apply 可安全讀取的形狀，並拒絕無法構成專案檔的資料。DOM、State、
   Media 與檔案 I/O 仍由 project.js 編排，避免把 runtime 效應帶進此 module。
============================================================================== */

export const CURRENT_PROJECT_SCHEMA_VERSION = 3;
const PROJECT_APP = 'SUB Tool';

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneProjectValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 將已由 project.js 蒐集好的專案純資料封裝為目前 .subtool 格式。
 * 不加儲存時間，否則 dirty 判斷會在未編輯時持續變動。
 */
export function createProjectSnapshot(document = {}) {
  const data = isRecord(document) ? cloneProjectValue(document) : {};
  return {
    ...data,
    app: PROJECT_APP,
    version: CURRENT_PROJECT_SCHEMA_VERSION,
  };
}

/**
 * 將歷史檔案整理成 Project.apply 可消費的資料形狀；不改寫既有欄位語意。
 * 缺少版本的舊檔保留為 v1，讓既有字幕軌索引轉換繼續生效。
 */
export function migrateProjectSchema(rawProject) {
  if (!isRecord(rawProject)) return null;
  const data = cloneProjectValue(rawProject);
  const rawVersion = data.version;
  if (rawVersion === undefined || rawVersion === null) data.version = 1;
  else {
    const version = Number(rawVersion);
    data.version = Number.isFinite(version) && version >= 1 ? Math.floor(version) : 1;
  }

  data.tracks = arrayOrEmpty(data.tracks);
  if (!data.tracks.length) data.tracks = [{ name: '軌道 1', visible: true, locked: false }];
  data.cues = arrayOrEmpty(data.cues);
  data.clips = arrayOrEmpty(data.clips);
  data.videoTracks = arrayOrEmpty(data.videoTracks);
  data.notes = arrayOrEmpty(data.notes);
  data.usedPresets = arrayOrEmpty(data.usedPresets);
  data.externalAudioSources = arrayOrEmpty(data.externalAudioSources);
  if (!isRecord(data.media)) data.media = {};
  if (!isRecord(data.audioProject)) delete data.audioProject;
  return data;
}

/** 驗證正規化後仍可安全套用的最低契約；不以嚴格 schema 阻斷舊檔。 */
export function validateProjectIntegrity(projectData) {
  const errors = [];
  if (!isRecord(projectData)) return { valid: false, errors: ['專案資料必須是 JSON 物件'] };
  if (!Number.isFinite(Number(projectData.version)) || Number(projectData.version) < 1) {
    errors.push('專案版本必須是大於等於 1 的數值');
  }
  if (projectData.fps !== undefined && (!Number.isFinite(Number(projectData.fps)) || Number(projectData.fps) <= 0)) {
    errors.push('專案 FPS 必須為大於 0 的數值');
  }
  for (const key of ['tracks', 'cues', 'clips']) {
    if (!Array.isArray(projectData[key])) errors.push(`專案 ${key} 必須為陣列`);
  }
  return { valid: errors.length === 0, errors };
}

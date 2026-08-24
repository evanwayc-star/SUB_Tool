/* ==============================================================================
   SUB Tool — 專案工作區快照與版本遷移權威 ("src/project-workspace-authority.js")
   ==============================================================================
   【架構與職責】
   純領域計算深層模組：負責專案序列化快照產生 (Snapshot Serialization)、
   歷史專案版本架構自動遷移 (Schema Migration) 與專案完整性校驗 (Integrity Validation)。
   ============================================================================== */

export const CURRENT_PROJECT_SCHEMA_VERSION = '6.7.0';

/**
 * 從全域狀態建立乾淨、無副作用的專案序列化快照。
 * 
 * @param {object} state 專案狀態物件
 * @returns {object} 專案快照 JSON 物件
 */
export function createProjectSnapshot(state) {
  if (!state || typeof state !== 'object') {
    return {
      version: CURRENT_PROJECT_SCHEMA_VERSION,
      cues: [],
      tracks: [],
      clips: [],
      fps: 30,
      dropFrame: false,
    };
  }

  return {
    version: CURRENT_PROJECT_SCHEMA_VERSION,
    fps: Number(state.fps) || 30,
    dropFrame: !!state.dropFrame,
    duration: Number(state.duration) || 0,
    tracks: Array.isArray(state.tracks) ? JSON.parse(JSON.stringify(state.tracks)) : [],
    cues: Array.isArray(state.cues) ? JSON.parse(JSON.stringify(state.cues)) : [],
    clips: Array.isArray(state.clips) ? JSON.parse(JSON.stringify(state.clips)) : [],
    videoTracks: Array.isArray(state.videoTracks) ? JSON.parse(JSON.stringify(state.videoTracks)) : [],
    audioProject: state.audioProject ? JSON.parse(JSON.stringify(state.audioProject)) : null,
    savedAt: new Date().toISOString(),
  };
}

/**
 * 專案版本自動向上遷移器（相容舊版存檔結構）。
 * 
 * @param {object} rawJson 原始專案 JSON
 * @returns {object} 升級至最新結構之專案物件
 */
export function migrateProjectSchema(rawJson) {
  if (!rawJson || typeof rawJson !== 'object') {
    return createProjectSnapshot(null);
  }

  const upgraded = { ...rawJson };

  // 補齊預設版本號
  if (!upgraded.version) {
    upgraded.version = '4.0.0';
  }

  // 確保 tracks 存在
  if (!Array.isArray(upgraded.tracks) || !upgraded.tracks.length) {
    upgraded.tracks = [{ id: 't0', name: '軌道 1', visible: true, locked: false }];
  }

  // 確保 cues 為陣列且皆有 id
  if (!Array.isArray(upgraded.cues)) {
    upgraded.cues = [];
  } else {
    upgraded.cues = upgraded.cues.map((c, idx) => ({
      ...c,
      id: c.id || `cue_${idx}_${Math.random().toString(36).slice(2, 6)}`,
      start: Number(c.start) || 0,
      end: Number(c.end) || 0,
      track: Number(c.track) || 0,
    }));
  }

  // 確保 clips 陣列
  if (!Array.isArray(upgraded.clips)) {
    upgraded.clips = [];
  }

  return upgraded;
}

/**
 * 專案資料完整性與關聯一致性校驗。
 * 
 * @param {object} projectData 專案資料
 * @returns {{valid: boolean, errors: Array<string>}} 校驗結果
 */
export function validateProjectIntegrity(projectData) {
  const errors = [];
  if (!projectData || typeof projectData !== 'object') {
    return { valid: false, errors: ['專案資料為空或格式錯誤'] };
  }

  if (typeof projectData.fps !== 'number' || projectData.fps <= 0) {
    errors.push('專案 FPS 必須為大於 0 之數值');
  }

  if (!Array.isArray(projectData.tracks)) {
    errors.push('字幕軌道清單 (tracks) 必須為陣列');
  }

  if (!Array.isArray(projectData.cues)) {
    errors.push('字幕清單 (cues) 必須為陣列');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/* ==============================================================================
   SUB Tool — 語音辨識背景工作階段管理器 (Speech Recognition Session Manager)
   ==============================================================================
   深層模組：集中管理當前進行中的語音辨識／文本匹配工作階段（ASR Session）。
   支援在背景持續推論、進度廣播、視窗最小化／喚回與中途取消。
   ============================================================================== */

let _currentSession = null;
const _listeners = new Set();

function _notifyListeners() {
  const snapshot = _currentSession;
  for (const listener of _listeners) {
    try {
      listener(snapshot);
    } catch (err) {
      console.error('[ASR Session] Listener error:', err);
    }
  }
}

/**
 * 取得當前活動的語音辨識工作階段（若無則回傳 null）
 */
export function getAsrSession() {
  return _currentSession;
}

/**
 * 訂閱語音辨識工作階段狀態變更
 * @param {Function} listener (session) => void
 * @returns {Function} 取消訂閱函式
 */
export function onAsrSessionChange(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

/**
 * 建立並啟動新的語音辨識工作階段
 */
export function startAsrSession(initData = {}) {
  if (_currentSession && _currentSession.controller && !_currentSession.controller.signal.aborted) {
    _currentSession.controller.abort();
  }
  const controller = initData.controller || new AbortController();
  const session = {
    id: `asr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    controller,
    signal: controller.signal,
    taskMode: initData.taskMode === 'align' ? 'align' : 'transcribe',
    provider: initData.provider || 'builtin',
    builtinModel: initData.builtinModel || '',
    language: initData.language || 'zh',
    clips: Array.isArray(initData.clips) ? initData.clips : [],
    currentClipIndex: 0,
    totalClips: Array.isArray(initData.clips) ? initData.clips.length : 1,
    transcript: typeof initData.transcript === 'string' ? initData.transcript : '',
    transcriptLines: Array.isArray(initData.transcriptLines) ? initData.transcriptLines : [],
    recognitionSelection: initData.recognitionSelection || 'all',
    guidance: initData.guidance || {},
    conf: initData.conf || {},
    progress: {
      status: 'preparing',
      percent: null,
      indeterminate: true,
      message: '正在準備音訊並進行分析…',
      file: ''
    },
    statusText: '正在準備音訊並進行分析…',
    results: [],
    error: null,
    dialogOpen: initData.dialogOpen !== false,
    diagnostic: null,
    recoveredAlignmentLineNumbers: [],
    failedAlignmentLineNumbers: [],
    recoveredEstimatedLineCount: 0,
    alignmentReviewCount: 0,
    alignmentProviderFailure: false,
    startTime: Date.now()
  };

  _currentSession = session;
  _notifyListeners();
  return session;
}

/**
 * 更新進行中工作階段的進度與訊息
 */
export function updateAsrSessionProgress(patch = {}) {
  if (!_currentSession) return;
  const currentProgress = _currentSession.progress || {};
  _currentSession.progress = {
    ...currentProgress,
    ...patch
  };
  if (patch.message && !_currentSession.statusText) {
    _currentSession.statusText = patch.message;
  }
  _notifyListeners();
}

/**
 * 更新進行中工作階段的文字狀態說明
 */
export function updateAsrSessionStatus(statusText) {
  if (!_currentSession) return;
  _currentSession.statusText = String(statusText || '');
  _notifyListeners();
}

/**
 * 設定對話框是否處於開啟狀態（關閉時視為在背景運行）
 */
export function setAsrSessionDialogOpen(dialogOpen) {
  if (!_currentSession) return;
  _currentSession.dialogOpen = !!dialogOpen;
  _notifyListeners();
}

/**
 * 中止並取消當前活動的語音辨識工作階段
 */
export function cancelActiveAsrSession() {
  if (!_currentSession) return null;
  const session = _currentSession;
  if (session.controller && !session.controller.signal.aborted) {
    session.controller.abort();
  }
  session.progress = {
    ...session.progress,
    status: 'cancelled',
    message: '辨識已取消'
  };
  session.statusText = '辨識已取消';
  _notifyListeners();
  _currentSession = null;
  _notifyListeners();
  return session;
}

/**
 * 標記工作階段已成功完成
 */
export function completeAsrSession(results = []) {
  if (!_currentSession) return;
  _currentSession.results = results;
  _currentSession.progress = {
    ..._currentSession.progress,
    status: 'completed',
    percent: 100,
    indeterminate: false,
    message: '辨識完成'
  };
  _notifyListeners();
}

/**
 * 標記工作階段失敗
 */
export function failAsrSession(error) {
  if (!_currentSession) return;
  _currentSession.error = error;
  _currentSession.progress = {
    ..._currentSession.progress,
    status: 'failed',
    message: error?.message || '辨識失敗'
  };
  _currentSession.statusText = `❌ 辨識失敗：${error?.message || String(error)}`;
  _notifyListeners();
}

/**
 * 清除已結束的工作階段
 */
export function clearAsrSession() {
  _currentSession = null;
  _notifyListeners();
}

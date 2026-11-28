import { $ } from './dom.js';
import { emit } from './events.js';
import { openModal } from './ui.js';
import { DEFAULT_SUBTITLE_DICTIONARY, createSubtitleDictionaryMatcher } from './subtitle-text-check.js';

const STORAGE_KEY = 'subtool_subtitle_check_dictionary';
let dictionary;
let matcher;

function readDictionary() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved?.entries) && saved.entries.every(entry => typeof entry === 'string') &&
        typeof saved.includeUnsupported === 'boolean') return saved;
  } catch { /* An unavailable store leaves the built-in dictionary usable. */ }
  return DEFAULT_SUBTITLE_DICTIONARY;
}

export function getSubtitleDictionaryMatcher() {
  dictionary ??= readDictionary();
  matcher ??= createSubtitleDictionaryMatcher(dictionary);
  return matcher;
}

export function openSubtitleDictionaryDialog() {
  dictionary ??= readDictionary();
  const session = openModal('編輯字庫', `
    <div class="subtitle-dictionary-editor">
      <label for="cpDictionaryEntries">字詞清單</label>
      <p id="cpDictionaryHelp">每行一個字或詞。例如輸入「你我他」，會找出含有完整「你我他」的字幕。</p>
      <textarea id="cpDictionaryEntries" aria-describedby="cpDictionaryHelp" placeholder="每行一個字或詞" spellcheck="false"></textarea>
      <label class="dictionary-options"><input id="cpDictionaryOther" type="checkbox">
        <span>一併檢查其他字元（如日文假名、韓文、俄文、零寬空白）</span>
      </label>
      <div class="dictionary-tools">
        <button id="cpDictionaryClear" type="button">清空字庫</button>
        <button id="cpDictionaryRestore" type="button">還原預設</button>
      </div>
      <p id="cpDictionaryError" role="alert" hidden></p>
    </div>`, [
    { label: '取消', act: () => session.close() },
    { label: '儲存字庫', primary: true, enterDefault: true, act: save },
  ]);
  const entries = $('cpDictionaryEntries');
  const other = $('cpDictionaryOther');
  const error = $('cpDictionaryError');

  function showDraft(value) {
    // Leave the first line ready for an addition, even with the full built-in list below it.
    entries.value = value.entries.length ? '\n' + value.entries.join('\n') : '';
    entries.setSelectionRange(0, 0);
    entries.scrollTop = 0;
    other.checked = value.includeUnsupported;
    error.hidden = true;
  }

  function save() {
    const next = { entries: [...new Set(entries.value.split('\n').filter(Boolean))], includeUnsupported: other.checked };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      error.textContent = '無法儲存字庫。請確認應用程式可使用本機儲存空間後重試。';
      error.hidden = false;
      return;
    }
    dictionary = next;
    matcher = createSubtitleDictionaryMatcher(next);
    session.close({ committed: true });
    emit('render:checkPanel');
  }

  showDraft(dictionary);
  $('cpDictionaryClear').onclick = () => {
    showDraft({ entries: [], includeUnsupported: false });
    entries.focus();
  };
  $('cpDictionaryRestore').onclick = () => {
    showDraft(DEFAULT_SUBTITLE_DICTIONARY);
    entries.focus();
  };
}

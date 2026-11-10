/* ==============================================================================
   SUB Tool — Module Architecture Protection ("src/settings.js")
   ==============================================================================
   【維護鐵律】本檔案已納入全專案終極防禦網。
   所有修改必須遵循專案的單向資料流與職責分離原則，嚴禁在此實作越權的 DOM 操作。
============================================================================== */
import { $, sublist } from './dom.js';
import { State, saveKeys, DESK, IS_DESKTOP } from './state.js';
import { setStatus, showToast } from './ui.js';
import { emit } from './events.js';
import { downloadBytes, pickFile, readFile, decodeText, bytesToB64, encodeUTF16LE } from './util.js';
import { bindFromEvent, findConflict, formatBind, mergeImportedKeymap, stripEmptyBinds } from './keybinding-engine.js';

const actionCategories = [
  {
    name: '播放控制',
    actions: {
      'toggle_play_pause': '播放或暫停',
      'rewind': '倒帶',
      'pause': '暫停',
      'forward': '正播',
      'prev_cue_5f': '退回至上一字幕起點前5格',
      'next_cue_5f': '退回至下一字幕起點前5格',
      'nudge_left_1f': '播放點往左平移1格',
      'nudge_left_1s': '播放點往左平移1秒',
      'nudge_left_5s': '播放點往左平移5秒',
      'nudge_right_1f': '播放點往右平移1格',
      'nudge_right_1s': '播放點往右平移1秒',
      'nudge_right_5s': '播放點往右平移5秒',
      'prev_note': '跳至上一個備註',
      'next_note': '跳至下一個備註',
      'seek_home': '回到開頭',
      'seek_end': '到達影片結尾',
    }
  },
  {
    name: '字幕操作',
    actions: {
      'set_in': '設定字幕起點 (或新建)',
      'set_out': '設定字幕終點',
      'step_boundary_prev': '跳轉至上一個邊界',
      'step_boundary_next': '跳轉至下一個邊界',
      'prev_cue': '跳至上一條字幕並選取',
      'next_cue': '跳至下一條字幕並選取',
      'first_cue': '跳至軌道第一條字幕',
      'last_cue': '跳至軌道最後一條字幕',
      'jump_cue_start': '將播放點移至選擇字幕的起點',
      'jump_cue_end': '將播放點移至選擇字幕的終點',
      'toggle_auto_select': '切換播放時自動選取對應字幕',
      'toggle_overwrite': '切換不覆蓋/可覆蓋狀態',
      'toggle_overwrite_keep': '切換保留/刪除狀態',
      'select_current': '選取目前播放點所在的字幕',
      'shift_timecode': '時間碼整體位移',
      'delete_selected': '刪除被選取的字幕',
      'cancel': '取消選取/關閉上字幕模式',
    }
  },
  {
    name: '文字編輯',
    actions: {
      // 編輯中的 Enter（確認離開）為 contenteditable 內建行為，不在 keymap；開啟編輯＝雙擊列表列
      'newline': '換行',
      'split_cue': '切分字幕',
    }
  },
  {
    name: '面板與工具',
    actions: {
      'toggle_history': '打開/關閉紀錄視窗',
      'toggle_notes': '打開/關閉備註視窗',
      'toggle_check_panel': '打開/關閉字幕檢查視窗',
      'toggle_mixer': '打開/關閉音量表',
      'toggle_safe_frame': '打開/關閉安全框',
      'add_note': '新增備註',
      'select_all': '全選當前軌道字幕',
      'copy_cues': '複製選取字幕',
      'paste_cues': '貼上字幕',
    }
  },
  {
    name: '匯出',
    actions: {
      'export_video': '開啟匯出交付清單',
      'open_queue_monitor': '打開匯出佇列監控（桌面版）',
    }
  },
  {
    name: '影片序列',
    actions: {
      'split_clip': '在播放點切割影片段',
    }
  },
  {
    name: '輸出範圍',
    actions: {
      'exp_in': '設定輸出起點',
      'exp_out': '設定輸出終點',
      'exp_clear': '清除輸出範圍',
    }
  },
  {
    name: '時間軸縮放',
    actions: {
      'zoom_out': '縮小時間軸',
      'zoom_in': '放大時間軸',
      'zoom_fit': '切換時間軸縮放模式',
    }
  },
  {
    name: '其他快捷',
    actions: {
      'toggle_sub_mode': '切換上字幕模式',
      'search': '打開搜尋框',
      'screenshot': '儲存畫面截圖',
      'screenshot_tc': '儲存畫面截圖帶時間碼',
      'undo': '復原',
      'redo': '重做',
      'save_project': '儲存專案',
      'save_as': '另存新檔'
    }
  }
];

let tempKeymap = null;
let activeSettingsClose = null;
let lastSettingsOrigin = null;
if (typeof document !== 'undefined') document.addEventListener('focusin', event => {
  if (!event.target.closest?.('#settingsModal') && event.target !== document.body) lastSettingsOrigin = event.target;
});

function renderSettingsTable(tbody, isCurrent, onChange, onConflict) {
  tbody.innerHTML = '';
  
  // Flat map for looking up labels
  const allLabels = {};
  for (const cat of actionCategories) {
    for (const [k, v] of Object.entries(cat.actions)) allLabels[k] = v;
  }

  const fixedActions = [
    'newline', 'split_cue',
    'select_all', 'copy_cues', 'paste_cues',
    'delete_selected', 'cancel',
    'save_project', 'save_as',
    'search', 'undo', 'redo',
    'exp_clear'
  ];

  /* exp_clear 是「同時按 [ 和 ]」的特殊組合，無法用標準 keymap 表示，
     在設定表格中以固定文字顯示 */
  const fixedDisplay = {
    'exp_clear': '[ + ]'
  };

  /* 重複判準與比對規則同住 keybinding-engine.js。 */
  function checkDuplicate(newBind) {
    const hit = findConflict(tempKeymap, newBind);
    return hit ? { ...hit, label: allLabels[hit.action] || hit.action } : null;
  }

  for (const category of actionCategories) {
    const hdr = document.createElement('tr');
    hdr.className = 'settings-category';
    hdr.dataset.category = category.name;
    hdr.innerHTML = `<th colspan="4" scope="rowgroup">${category.name}</th>`;
    tbody.appendChild(hdr);

    for (const [action, label] of Object.entries(category.actions)) {
      const tr = document.createElement('tr');
      tr.id = 'settings-row-' + action;
      tr.dataset.category = category.name;
      tr.dataset.search = `${category.name} ${label}`;
      
      const tdLabel = document.createElement('td');
      tdLabel.textContent = label;
      if (fixedActions.includes(action)) {
        const note = document.createElement('span'); note.className='settings-fixed';note.textContent='固定';tdLabel.appendChild(note);
      }
      tr.appendChild(tdLabel);

      const binds = tempKeymap[action] || [];
      
      for (let i = 0; i < 3; i++) {
        const tdKey = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'key-input';
        input.id = `settings-input-${action}-${i}`;
        input.setAttribute('aria-label', `${label}，第 ${i+1} 組快捷鍵`);
        input.setAttribute('aria-describedby', 'settingsKeyboardHelp settingsError');
        input.value = fixedDisplay[action] && i === 0 ? fixedDisplay[action] : formatBind(binds[i]);
        
        const isFixed = fixedActions.includes(action);
        if (isFixed) {
          input.disabled = true;
        } else {
          input.placeholder = '點此設定...';
          input.readOnly = true;
        }
        
        const updateStyle = () => {
          if (isFixed) return;
          if (input.value) input.classList.add('has-bind');
          else input.classList.remove('has-bind');
        };
        updateStyle();
        
        if (!isFixed) {
          input.addEventListener('keydown', (e) => {
            if (!isCurrent()) return;
            // Tab 專供鍵盤導航，不能因巡覽設定表就改寫草稿。
            if (e.key === 'Tab' || e.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            e.stopPropagation();
          
          if (e.key === 'Escape') {
            input.blur();
            return;
          }

          if (e.key === 'Backspace' || e.key === 'Delete') {
            binds[i] = null;
            // 草稿索引對應畫面的三個欄位；儲存時才壓縮空位，避免衝突提示指錯欄。
            tempKeymap[action] = binds;
            input.value = '';
            updateStyle();
            onChange();
            return;
          }

          // 單獨的修飾鍵不算一個綁定（判斷同樣在 keybinding-engine.js）
          const bind = bindFromEvent(e);
          if (!bind) return;

          // Check for duplicate
          const dupInfo = checkDuplicate(bind);
          if (dupInfo) {
            onConflict(`「${formatBind(bind)}」已指派給「${dupInfo.label}」，請改用其他按鍵，或先清除原綁定。`);
            input.setAttribute('aria-invalid','true');
            input.blur();
            const targetRow = document.getElementById('settings-row-' + dupInfo.action);
            if (targetRow) {
              targetRow.scrollIntoView?.({ block: 'nearest' });
            }
            const targetInput = document.getElementById(`settings-input-${dupInfo.action}-${dupInfo.index}`);
            if (targetInput) {
              targetInput.classList.add('flash-duplicate');
            }
            return;
          }

          binds[i] = bind;
          tempKeymap[action] = binds;
          input.value = formatBind(bind);
          updateStyle();
          onChange();
          input.blur();
        });
        } // End of if(!isFixed)

        tdKey.appendChild(input);
        tr.appendChild(tdKey);
      }
      tbody.appendChild(tr);
    }
  }
}

export function showSettingsModal() {
  // Closing a previous instance also releases its document-level Escape listener.
  if (activeSettingsClose?.() === false) return;
  const existing = document.getElementById('settingsModal');
  if (existing) existing.remove();

  tempKeymap = JSON.parse(JSON.stringify(State.keymap));
  let draftRevision = 0;
  let saving = false;
  // 工具列的 action dispatcher 會先 blur 按鈕；保留其最後一次實際焦點。
  const previousFocus = document.activeElement === document.body && lastSettingsOrigin?.isConnected
    ? lastSettingsOrigin : document.activeElement;

  const modal = document.createElement('div');
  modal.id = 'settingsModal';
  modal.innerHTML = `
    <div class="settings-modal-content" role="dialog" aria-modal="true" aria-labelledby="settingsTitle" tabindex="-1">
      <h2 id="settingsTitle">快捷鍵設定</h2>
      <div class="settings-search-bar">
        <label for="settingsSearch">尋找快捷鍵</label>
        <div class="settings-search-controls"><input id="settingsSearch" type="search" placeholder="搜尋動作或按鍵，例如：播放、Ctrl+S" autocomplete="off" aria-controls="settingsTbody" aria-describedby="settingsResultCount"><button id="settingsSearchClear" class="btn" type="button" hidden>清除搜尋</button></div>
        <span id="settingsResultCount" role="status" aria-live="polite"></span>
      </div>
      <p id="settingsKeyboardHelp" class="settings-keyboard-help">按 Tab 切換欄位，再按下要設定的按鍵。Delete／Backspace 清除，Escape 結束錄製；標示「固定」的項目無法修改。儲存後才生效。</p>
      <div class="settings-table-container">
        <table class="settings-table">
          <thead>
            <tr>
              <th scope="col">動作</th>
              <th scope="col">第一組</th>
              <th scope="col">第二組</th>
              <th scope="col">第三組</th>
            </tr>
          </thead>
          <tbody id="settingsTbody"></tbody>
        </table>
        <p id="settingsEmpty" class="settings-empty" hidden>找不到符合的快捷鍵。請換個關鍵字，或清除搜尋查看全部。</p>
      </div>
      <div id="settingsError" class="settings-error" role="alert" hidden></div>
      <div class="settings-footer">
        <div class="settings-file-actions"><button id="settingsRestoreBtn" class="btn">還原預設</button>
        <button id="settingsExportBtn" class="btn" title="把目前這份快捷鍵設定存成 .json 檔">匯出設定</button>
        <button id="settingsImportBtn" class="btn" title="從 .json 檔載入快捷鍵設定（需按「儲存」才生效）">匯入設定</button></div>
        <div class="settings-save-actions">
        <button id="settingsCancelBtn" class="btn">取消</button>
        <button id="settingsSaveBtn" class="btn primary">儲存</button></div>
      </div>
      <input type="file" id="settingsImportFile" accept="application/json,.json" hidden>
    </div>
  `;
  document.body.appendChild(modal);
  const background = [...document.body.children].filter(element=>element!==modal&&!['SCRIPT','STYLE'].includes(element.tagName))
    .map(element=>({element,inert:element.inert}));
  background.forEach(({element})=>{element.inert=true;});
  emit('mpv:sync'); // mpv 是 OS 層子視窗會蓋住本對話框，開啟期間讓 mpv 讓位

  const isCurrent = () => activeSettingsClose === close && document.getElementById('settingsModal') === modal;
  const canEdit = () => isCurrent() && !saving;
  const close = () => {
    // 已送出的儲存不能由關窗撤銷；等待結果才能丟棄草稿或開下一個視窗。
    if (saving) return false;
    document.removeEventListener('keydown', onEsc, true);
    document.removeEventListener('focusin', containFocus, true);
    if (activeSettingsClose === close) activeSettingsClose = null;
    modal.remove();
    background.forEach(({element,inert})=>{element.inert=inert;});
    if(previousFocus?.isConnected) previousFocus.focus({preventScroll:true});
    emit('mpv:sync');
    return true;
  };
  activeSettingsClose = close;

  const tbody = document.getElementById('settingsTbody');
  const search = modal.querySelector('#settingsSearch');
  const filterRows = () => {
    const query=search.value.trim().toLocaleLowerCase().replace(/\s+/g,'');
    const rows=[...tbody.querySelectorAll('tr[data-search]')];
    let count=0;
    for(const row of rows){
      const text=(row.dataset.search+' '+[...row.querySelectorAll('input')].map(input=>input.value).join(' ')).toLocaleLowerCase().replace(/\s+/g,'');
      row.hidden=!!query&&!text.includes(query);if(!row.hidden) count++;
    }
    for(const heading of tbody.querySelectorAll('.settings-category')) heading.hidden=!rows.some(row=>row.dataset.category===heading.dataset.category&&!row.hidden);
    modal.querySelector('#settingsResultCount').textContent=query?`${count} / ${rows.length} 項動作`:`共 ${rows.length} 項動作`;
    modal.querySelector('#settingsEmpty').hidden=count!==0;
    modal.querySelector('#settingsSearchClear').hidden=!search.value;
  };
  const renderDraft = () => {renderSettingsTable(tbody, canEdit, () => {
    draftRevision++;showError('');
    for(const input of tbody.querySelectorAll('[aria-invalid],.flash-duplicate')) {input.removeAttribute('aria-invalid');input.classList.remove('flash-duplicate');}
  }, message=>{
    for(const input of tbody.querySelectorAll('[aria-invalid],.flash-duplicate')) {input.removeAttribute('aria-invalid');input.classList.remove('flash-duplicate');}
    search.value='';filterRows();showError(message);
  });filterRows();};
  const dialog = modal.querySelector('[role="dialog"]');
  const focusables = () => [...modal.querySelectorAll('button, input')]
    .filter(element=>!element.disabled&&!element.closest('[hidden]')&&element.type!=='file'&&element.tabIndex!==-1);
  const focusFirst = () => (focusables()[0]||dialog).focus({preventScroll:true});
  const containFocus = event => { if(isCurrent()&&!modal.contains(event.target)) focusFirst(); };
  document.addEventListener('focusin', containFocus, true);
  modal.addEventListener('keydown',event=>{
    if(event.key!=='Tab'||!isCurrent()) return;
    const items=focusables(),first=items[0],last=items[items.length-1];
    if(!items.length){event.preventDefault();dialog.focus();return;}
    if(event.shiftKey&&(document.activeElement===first||!items.includes(document.activeElement))){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||!items.includes(document.activeElement))){event.preventDefault();first.focus();}
  },true);
  const showError = message => {
    const error = modal.querySelector('#settingsError');
    error.textContent=message;error.hidden=!message;
    if(message) setStatus(message,'err');
  };
  renderDraft();
  search.addEventListener('input',filterRows);
  modal.querySelector('#settingsSearchClear').onclick=()=>{search.value='';filterRows();search.focus();};

  document.getElementById('settingsRestoreBtn').onclick = () => {
    if (!canEdit()) return;
    draftRevision++;
    tempKeymap = JSON.parse(JSON.stringify(State.defaultKeymap));
    showError('');
    renderDraft();
  };

  // 匯出：把目前編輯中的這份 keymap 存成 json（桌面走原生存檔對話框、網頁走下載）
  document.getElementById('settingsExportBtn').onclick = async () => {
    if (!canEdit()) return;
    const keymap = stripEmptyBinds(structuredClone(tempKeymap));
    const json = JSON.stringify({ _type: 'subtool-keymap', version: 1, keymap }, null, 2);
    const bytes = encodeUTF16LE(json);
    const name = 'SUBTool_快捷鍵.json';
    try {
      if (IS_DESKTOP && DESK.exportSub) {
        const p = await DESK.exportSub(name, bytesToB64(bytes), 'json');
        if (p && isCurrent()) showToast('已匯出快捷鍵：' + p.split(/[\\/]/).pop());
      } else { downloadBytes(bytes, name, 'application/json;charset=utf-16le'); showToast('已匯出快捷鍵設定'); }
    } catch (e) { if (isCurrent()) showError('匯出失敗：' + (e?.message || e)); }
  };

  // 匯入：讀 json → 驗證 → 併到預設 keymap（缺項用預設補、未知動作忽略）→ 重繪表格（需按「儲存」才寫入）
  document.getElementById('settingsImportBtn').onclick = async () => {
    if (!canEdit()) return;
    const revision = ++draftRevision;
    const ownsImport = () => isCurrent() && revision === draftRevision;
    const f = await pickFile(document.getElementById('settingsImportFile')); if (!f) return;
    if (!ownsImport()) return;
    try {
      const obj = JSON.parse(decodeText(await readFile(f)));
      if (!ownsImport()) return;
      // 只採用「本版本認得的動作」，其餘一律以預設補齊（規則見 keybinding-engine.js）
      const { keymap: merged, applied } = mergeImportedKeymap(State.defaultKeymap, obj);
      tempKeymap = merged;
      showError('');
      renderDraft();
      showToast(`已匯入 ${applied} 項快捷鍵；按「儲存」才會生效`);
    } catch (e) { if (ownsImport()) showError('匯入失敗：' + (e?.message || e)); }
  };

  /* 取消＝丟棄 tempKeymap 直接關掉（尚未寫進 State.keymap）。
     Esc 與「取消」走同一條路，不可各寫一份。 */
  const cancel = () => {
    if (canEdit()) close();
  };

  /* 這個對話框是自己 createElement 出來的，不走 ui.js 的 openModal，
     所以 keyboard.js 那條「modalBg 開著時 Esc → closeModal」完全管不到它，
     必須自己接。用捕獲階段是為了搶在全域快捷鍵之前。

     但快捷鍵輸入框自己也用 Esc（＝取消這一次錄製、把焦點移開），
     而它是在冒泡階段處理的——捕獲階段若無條件關閉整個對話框，
     使用者在錄製到一半按 Esc 就會連設定視窗一起關掉，剛改的內容全丟。
     所以焦點在綁定輸入框裡時要讓開，交給輸入框自己處理。 */
  const onEsc = (e) => {
    if (e.key !== 'Escape') return;
    if (!isCurrent()) { document.removeEventListener('keydown', onEsc, true); return; }
    if (saving) { e.preventDefault(); e.stopPropagation(); return; }
    const t = e.target;
    if (t===search && search.value) {e.preventDefault();e.stopPropagation();search.value='';filterRows();return;}
    if (t?.classList?.contains('key-input')) return; // 錄製中：讓輸入框自己 blur
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  document.addEventListener('keydown', onEsc, true);

  document.getElementById('settingsCancelBtn').onclick = cancel;

  document.getElementById('settingsSaveBtn').onclick = async () => {
    if (!canEdit()) return;
    draftRevision++;
    const keymap = stripEmptyBinds(structuredClone(tempKeymap));
    const controls = [...modal.querySelectorAll('input, button')].map(control => ({ control, disabled:control.disabled }));
    saving = true;
    modal.querySelector('#settingsSaveBtn').textContent='儲存中…';
    showError('');
    for (const { control } of controls) control.disabled = true;
    dialog.focus({preventScroll:true});
    setStatus('正在儲存快捷鍵…', 'busy');
    let saved = false, error;
    try { saved = await saveKeys(keymap); }
    catch (failure) { error = failure; }
    finally {
      saving = false;
      modal.querySelector('#settingsSaveBtn').textContent='儲存';
      for (const { control, disabled } of controls) control.disabled = disabled;
    }
    if (!isCurrent()) return;
    if (!saved) {
      showError('快捷鍵設定儲存失敗，請重試' + (error ? '：' + (error.message || error) : ''));
      document.getElementById('settingsSaveBtn').focus();
      return;
    }
    State.keymap = keymap;
    close();
    setStatus('快捷鍵設定已儲存', 'ok');
  };
  focusFirst();
}


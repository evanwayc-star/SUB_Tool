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
import { downloadBytes, pickFile, readFile, decodeText, bytesToB64 } from './util.js';
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

function renderSettingsTable(tbody) {
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

  /* 重複判準與比對規則同住 keybinding.js——兩者不一致的後果見該檔檔頭。 */
  function checkDuplicate(newBind) {
    const hit = findConflict(tempKeymap, newBind);
    return hit ? { ...hit, label: allLabels[hit.action] || hit.action } : null;
  }

  for (const category of actionCategories) {
    const hdr = document.createElement('tr');
    hdr.innerHTML = `<td colspan="4" style="background:var(--panel3); color:var(--text); font-weight:bold; padding:12px 10px; border-top:2px solid var(--border2);">${category.name}</td>`;
    tbody.appendChild(hdr);

    for (const [action, label] of Object.entries(category.actions)) {
      const tr = document.createElement('tr');
      tr.id = 'settings-row-' + action;
      
      const tdLabel = document.createElement('td');
      tdLabel.textContent = label;
      tr.appendChild(tdLabel);

      const binds = tempKeymap[action] || [];
      
      for (let i = 0; i < 3; i++) {
        const tdKey = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'key-input';
        input.id = `settings-input-${action}-${i}`;
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
            e.preventDefault();
            e.stopPropagation();
          
          if (e.key === 'Escape') {
            input.blur();
            return;
          }

          if (e.key === 'Backspace' || e.key === 'Delete') {
            binds[i] = null;
            tempKeymap[action] = binds.filter(b => b !== null);
            input.value = '';
            updateStyle();
            return;
          }

          // 單獨的修飾鍵不算一個綁定（判斷同樣在 keybinding.js）
          const bind = bindFromEvent(e);
          if (!bind) return;

          // Check for duplicate
          const dupInfo = checkDuplicate(bind);
          if (dupInfo) {
            setStatus(`該快捷鍵已經被指派給「${dupInfo.label}」`, 'err');
            input.blur();
            const targetRow = document.getElementById('settings-row-' + dupInfo.action);
            if (targetRow) {
              targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            const targetInput = document.getElementById(`settings-input-${dupInfo.action}-${dupInfo.index}`);
            if (targetInput) {
              targetInput.classList.remove('flash-duplicate');
              void targetInput.offsetWidth; // Trigger reflow
              targetInput.classList.add('flash-duplicate');
            }
            return;
          }

          binds[i] = bind;
          tempKeymap[action] = binds;
          input.value = formatBind(bind);
          updateStyle();
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
  const existing = document.getElementById('settingsModal');
  if (existing) existing.remove();

  tempKeymap = JSON.parse(JSON.stringify(State.keymap));

  const modal = document.createElement('div');
  modal.id = 'settingsModal';
  modal.innerHTML = `
    <div class="settings-modal-content">
      <h2>快捷鍵設定</h2>
      <div class="settings-table-container">
        <table class="settings-table">
          <thead>
            <tr>
              <th>項目</th>
              <th>第一組快捷鍵</th>
              <th>第二組快捷鍵</th>
              <th>第三組快捷鍵</th>
            </tr>
          </thead>
          <tbody id="settingsTbody"></tbody>
        </table>
      </div>
      <div class="settings-footer">
        <button id="settingsRestoreBtn" class="btn" style="margin-right:auto;">還原預設</button>
        <button id="settingsExportBtn" class="btn" title="把目前這份快捷鍵設定存成 .json 檔">⭳ 匯出</button>
        <button id="settingsImportBtn" class="btn" title="從 .json 檔載入快捷鍵設定（需按「儲存」才生效）">⭱ 匯入</button>
        <button id="settingsCancelBtn" class="btn">取消</button>
        <button id="settingsSaveBtn" class="btn primary">儲存</button>
      </div>
      <input type="file" id="settingsImportFile" accept="application/json,.json" hidden>
    </div>
  `;
  document.body.appendChild(modal);
  emit('mpv:sync'); // mpv 是 OS 層子視窗會蓋住本對話框，開啟期間讓 mpv 讓位

  const tbody = document.getElementById('settingsTbody');
  renderSettingsTable(tbody);

  document.getElementById('settingsRestoreBtn').onclick = () => {
    tempKeymap = JSON.parse(JSON.stringify(State.defaultKeymap));
    renderSettingsTable(tbody);
  };

  // 匯出：把目前編輯中的這份 keymap 存成 json（桌面走原生存檔對話框、網頁走下載）
  document.getElementById('settingsExportBtn').onclick = async () => {
    const json = JSON.stringify({ _type: 'subtool-keymap', version: 1, keymap: tempKeymap }, null, 2);
    const bytes = new TextEncoder().encode(json);
    const name = 'SUBTool_快捷鍵.json';
    try {
      if (IS_DESKTOP && DESK.exportSub) {
        const p = await DESK.exportSub(name, bytesToB64(bytes), 'json');
        if (p) showToast('已匯出快捷鍵：' + p.split(/[\\/]/).pop());
      } else { downloadBytes(bytes, name, 'application/json'); showToast('已匯出快捷鍵設定'); }
    } catch (e) { setStatus('匯出失敗：' + (e?.message || e), 'err'); }
  };

  // 匯入：讀 json → 驗證 → 併到預設 keymap（缺項用預設補、未知動作忽略）→ 重繪表格（需按「儲存」才寫入）
  document.getElementById('settingsImportBtn').onclick = async () => {
    const f = await pickFile(document.getElementById('settingsImportFile')); if (!f) return;
    try {
      const obj = JSON.parse(decodeText(await readFile(f)));
      // 只採用「本版本認得的動作」，其餘一律以預設補齊（規則見 keybinding.js）
      const { keymap: merged, applied } = mergeImportedKeymap(State.defaultKeymap, obj);
      tempKeymap = merged;
      renderSettingsTable(tbody);
      showToast(`已匯入 ${applied} 項快捷鍵；按「儲存」才會生效`);
    } catch (e) { setStatus('匯入失敗：' + (e?.message || e), 'err'); showToast('匯入失敗：' + (e?.message || e)); }
  };

  /* 取消＝丟棄 tempKeymap 直接關掉（尚未寫進 State.keymap）。
     Esc 與「取消」走同一條路，不可各寫一份。 */
  const cancel = () => {
    document.removeEventListener('keydown', onEsc, true);
    modal.remove();
    emit('mpv:sync');
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
    if (!document.getElementById('settingsModal')) { document.removeEventListener('keydown', onEsc, true); return; }
    const t = e.target;
    if (t && t.tagName === 'INPUT' && t.closest('#settingsModal')) return; // 錄製中：讓輸入框自己 blur
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  document.addEventListener('keydown', onEsc, true);

  document.getElementById('settingsCancelBtn').onclick = cancel;

  document.getElementById('settingsSaveBtn').onclick = () => {
    State.keymap = stripEmptyBinds(tempKeymap);
    saveKeys();
    document.removeEventListener('keydown', onEsc, true);
    modal.remove();
    emit('mpv:sync');
    setStatus('快捷鍵設定已儲存', 'ok');
  };
}


import { $, sublist } from './dom.js';
import { State, saveKeys } from './state.js';
import { setStatus } from './ui.js';

const actionCategories = [
  {
    name: '播放控制',
    actions: {
      'toggle_play_pause': '播放或暫停',
      'rewind': '倒帶 (-1x 到 -5x，每階 0.5x)',
      'pause': '暫停',
      'forward': '正播 (1x 到 5x，每階 0.5x)',
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
      'step_boundary_prev': '跳轉至上一個字幕邊界',
      'step_boundary_next': '跳轉至下一個字幕邊界',
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
      'confirm': '確認並離開編輯 / 開啟編輯',
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
      'add_note': '新增備註',
      'select_all': '全選當前軌道字幕',
      'copy_cues': '複製選取字幕',
      'paste_cues': '貼上字幕',
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
      'undo': '復原',
      'redo': '重做',
      'save_project': '儲存專案',
      'save_as': '另存新檔'
    }
  }
];

function formatKeyBind(bind) {
  if (!bind) return '';
  const parts = [];
  if (bind.ctrl) parts.push('Ctrl');
  if (bind.shift) parts.push('Shift');
  if (bind.alt) parts.push('Alt');
  if (bind.code && bind.code.startsWith('Numpad')) {
    const nmap = { 'NumpadAdd':'Num +', 'NumpadSubtract':'Num -', 'NumpadMultiply':'Num *', 'NumpadDivide':'Num /', 'NumpadEnter':'Num Enter', 'NumpadDecimal':'Num .' };
    parts.push(nmap[bind.code] || bind.code.replace('Numpad', 'Num '));
  } else if (bind.key) {
    if (bind.key === ' ') parts.push('Space');
    else if (bind.key === 'escape') parts.push('Esc');
    else if (bind.key === 'arrowup') parts.push('↑');
    else if (bind.key === 'arrowdown') parts.push('↓');
    else if (bind.key === 'arrowleft') parts.push('←');
    else if (bind.key === 'arrowright') parts.push('→');
    else parts.push(bind.key.charAt(0).toUpperCase() + bind.key.slice(1));
  }
  return parts.join(' + ');
}

let tempKeymap = null;

function renderSettingsTable(tbody) {
  tbody.innerHTML = '';
  
  // Flat map for looking up labels
  const allLabels = {};
  for (const cat of actionCategories) {
    for (const [k, v] of Object.entries(cat.actions)) allLabels[k] = v;
  }

  const fixedActions = [
    'confirm', 'newline', 'split_cue',
    'select_all', 'copy_cues', 'paste_cues',
    'delete_selected', 'cancel',
    'save_project', 'save_as',
    'search', 'undo', 'redo'
  ];

  function checkDuplicate(newBind) {
    for (const [action, binds] of Object.entries(tempKeymap)) {
      if (!binds) continue;
      for (let i = 0; i < binds.length; i++) {
        const b = binds[i];
        if (!b) continue;
        if (!!b.ctrl === !!newBind.ctrl &&
            !!b.shift === !!newBind.shift &&
            !!b.alt === !!newBind.alt &&
            b.key === newBind.key &&
            b.code === newBind.code) {
          return { label: allLabels[action] || action, action, index: i };
        }
      }
    }
    return null;
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
        input.value = formatKeyBind(binds[i]);
        
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

          // Ignore standalone modifiers
          if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

          const bind = {
            key: e.key.toLowerCase(),
          };
          if (e.code && e.code.startsWith('Numpad')) {
            bind.code = e.code;
            delete bind.key; // Prefer code for numpad
          }
          if (e.ctrlKey || e.metaKey) bind.ctrl = true;
          if (e.shiftKey) bind.shift = true;
          if (e.altKey) bind.alt = true;

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
          input.value = formatKeyBind(bind);
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
        <button id="settingsCancelBtn" class="btn">取消</button>
        <button id="settingsSaveBtn" class="btn primary">儲存</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const tbody = document.getElementById('settingsTbody');
  renderSettingsTable(tbody);

  document.getElementById('settingsRestoreBtn').onclick = () => {
    tempKeymap = JSON.parse(JSON.stringify(State.defaultKeymap));
    renderSettingsTable(tbody);
  };

  document.getElementById('settingsCancelBtn').onclick = () => {
    modal.remove();
  };

  document.getElementById('settingsSaveBtn').onclick = () => {
    // Clean up empty bindings
    for (const k in tempKeymap) {
      tempKeymap[k] = tempKeymap[k].filter(b => b !== null);
    }
    State.keymap = tempKeymap;
    saveKeys();
    modal.remove();
    setStatus('快捷鍵設定已儲存', 'ok');
  };
}

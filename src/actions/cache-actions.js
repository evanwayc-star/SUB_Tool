import { State } from '../state.js';
import { showToast, openModal, closeModal } from '../ui.js';
import { escapeHTML } from '../util.js';
import { $ } from '../dom.js';

export function _fmtBytes(n){ 
  n = +n || 0; 
  if (n < 1024) return n + ' B'; 
  const u = ['KB','MB','GB','TB']; 
  let i = -1; 
  do { n /= 1024; i++; } while(n >= 1024 && i < u.length - 1); 
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i]; 
}

let _cacheDlgGen = 0;

export async function openCacheDialog(){
  const DESK = window.subtool;
  if (!DESK || !DESK.cacheInfo) { showToast('快取管理僅在桌面版可用'); return; }
  const myGen = ++_cacheDlgGen;
  openModal('🗂 轉檔快取', '<div style="padding:6px 2px">讀取中…</div>', [{ label:'關閉', primary: true, act: closeModal }]);
  
  let info; 
  try { 
    info = await DESK.cacheInfo(); 
  } catch(e) { 
    info = { folders: 0, bytes: 0, root: '' }; 
  }
  
  // 使用者在讀取期間已關閉（或又開了別的對話框）就不要把對話框彈回來
  if (myGen !== _cacheDlgGen || !$('modalBg').classList.contains('show')) return;
  
  const html =
    `<div style="padding:4px 2px;line-height:1.9">` +
    `<div>中央快取：<b>${info.folders}</b> 個項目，共 <b>${_fmtBytes(info.bytes)}</b></div>` +
    `<div style="font-size:11px;color:var(--muted);word-break:break-all;margin-top:2px">${escapeHTML(info.root || '')}</div>` +
    `<div style="font-size:12px;color:var(--muted);margin-top:8px">說明：開啟影片時會把每個聲道與波形轉存到「影片同資料夾的 <code>.subtool_Cache</code>」內，其他電腦讀取同一個檔案時可直接沿用、不必重算。此處管理的是本機的中央快取。</div>` +
    `</div>`;
    
  const buttons = [
    { label: '清理孤兒檔', act: async () => { 
        const r = await DESK.cacheCleanOrphans(); 
        showToast(`已清理 ${r.removed} 個無效項目，釋放 ${_fmtBytes(r.bytes)}`); 
        openCacheDialog(); 
      }
    },
    { label: '全部清除', act: () => {
        openModal('確認清除', '<div style="padding:6px 2px">將刪除所有中央快取，以及目前開啟影片旁的 .subtool_Cache 資料夾。<br>下次開啟同檔需重新轉檔。確定？</div>', [
          { label: '確定清除', primary: true, act: async () => { 
              const r = await DESK.cacheClearAll(State.mediaPath || null); 
              showToast(`已清除快取，釋放 ${_fmtBytes(r.bytes)}`); 
              closeModal(); 
            }
          },
          { label: '取消', act: openCacheDialog }
        ]);
      }
    },
    { label: '關閉', primary: true, act: closeModal },
  ];
  openModal('🗂 轉檔快取', html, buttons);
}

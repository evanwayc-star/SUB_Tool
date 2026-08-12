import { Media } from '../media.js';
import { getPlayerAdapter } from '../media-player-adapter.js';
import { _syncMpvPanel } from '../video-renderer.js';
import { $ } from '../dom.js';

export function _ensurePanelInRightArea(panel){
  if(!Media.mpvMode || !getPlayerAdapter().isAvailable) return;
  const vr=$('videoWrap')?.getBoundingClientRect();
  if(!vr) return;
  const pr=panel.getBoundingClientRect();
  if(pr.left < vr.right + 4){
    panel.style.right='auto'; panel.style.bottom='auto';
    panel.style.left=(vr.right+8)+'px';
    panel.style.top=Math.max(50, Math.min(pr.top, window.innerHeight-120))+'px';
  }
}

export function togglePanel(id){ 
  const p=$(id); 
  const willShow=!p.classList.contains('show');
  document.querySelectorAll('.float-panel.show').forEach(x=>x.classList.remove('show'));
  if(willShow){ 
    p.classList.add('show'); 
    setTimeout(()=>{ _ensurePanelInRightArea(p); _syncMpvPanel(); },0); 
  } else {
    _syncMpvPanel();
  }
}

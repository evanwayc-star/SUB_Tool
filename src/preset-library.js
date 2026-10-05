/* 常用樣式管理與草稿編輯：此 module 擁有完整 modal / 非同步匯入生命週期。 */
import { $ } from './dom.js';
import { State, DESK, IS_DESKTOP } from './state.js';
import { StylePanelController } from './style-panel-controller.js';
import { openModal, closeModal, showToast } from './ui.js';
import { STYLE_DEFAULTS, BUILTIN_PRESETS, effStyle, getPresets, getAllPresets, isBuiltinPresetName, savePresets, styleMatchesPreset, validPresetList, presetIdentity, capturePresetUpdate } from './substyle.js';
import { refreshStyleSummaries, applyCueStylePatch } from './subtitles.js';
import { recordHistory } from './history.js';
import { renderVideoSub, refreshMpvSubs } from './video-renderer.js';
import { escapeHTML, downloadBytes, bytesToB64, b64ToBytes } from './util.js';
import { presetExportRelativePath } from './export-job-engine.js';

export function initPresetLibrary({ styleChanged }){
  let managerSession = null;
  const ownsDraft = draft => draft.ownerTracks === State.tracks && draft.ownerCues === State.cues
    && getPresets()[draft.ui] === draft.preset
    && draft.targets.tracks.every(i => State.tracks[i] === draft.trackOwners[i])
    && draft.targets.cues.every(c => State.cues.includes(c));
  const revokeDraft = () => { State.presetEdit = null; if ($('tsEditBar')) $('tsEditBar').hidden = true; };
  const syncDraft = () => {
    if (State.presetEdit && !ownsDraft(State.presetEdit)) { revokeDraft(); styleChanged(); }
    if (!State.presetEdit && $('tsEditBar')) $('tsEditBar').hidden = true;
  };
  /* 常用樣式管理：每列＝小色票預覽＋名稱＋套用/改名/刪除。事件用委派（一次綁在 modalBody），
     操作後就地重繪列表、不關視窗（可連續管理）。 */
  const _presetSwatch=st=>`<span style="display:inline-block;min-width:30px;padding:2px 7px;border-radius:4px;`+
    `font-size:12px;font-weight:${st.bold?700:400};font-style:${st.italic?'italic':'normal'};`+
    `background:${escapeHTML(st.bgBox?st.bgColor:'#222')};color:${escapeHTML(st.color)};`+
    `border:1px solid rgba(255,255,255,.2);${st.outline>0?`text-shadow:0 0 2px ${escapeHTML(st.outlineColor)},0 0 2px ${escapeHTML(st.outlineColor)};`:''}">字</span>`;
  function _renderPresetMgr(session = managerSession){
    if (!session?.isCurrent()) return;
    // 清單＝內建（第一筆，不可改名／刪除）＋使用者自訂
    const list=getAllPresets();
    const body=$('modalBody'); if(!body)return;

    // 分組
    const groups = new Map();
    const orphans = [];
    list.forEach((p, i) => {
      if (p.builtin) {
        orphans.push({ p, i, text: p.name });
        return;
      }
      if (p.group) {
        if (!groups.has(p.group)) groups.set(p.group, []);
        groups.get(p.group).push({ p, i, text: p.name });
      } else {
        orphans.push({ p, i, text: p.name });
      }
    });

    const renderItem = (item, isGrouped) => {
      const { p, i, text } = item;
      const st=Object.assign({},STYLE_DEFAULTS,p.style||{});
      const ui=i-BUILTIN_PRESETS.length;
      return `<div style="display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--border);">`+
        _presetSwatch(st)+
        `<span style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHTML(text)}`+
        (p.builtin?`<span style="margin-left:6px;font-size:10px;padding:1px 5px;border-radius:8px;background:var(--panel3);color:var(--text-faint)">內建</span>`:'')+
        `</span>`+
        `<button class="ts-preset" data-pre-apply="${i}" title="套用到目前選取的字幕（或整軌）">套用</button>`+
        (p.builtin
          ? `<span style="font-size:11px;color:var(--text-faint);opacity:.6;padding:0 6px">不可修改</span>`
          : `<button class="ts-preset" data-pre-edit="${ui}" title="在樣式面板上修改這組樣式；完成後所有套用它的字幕一起變">修改參數</button>`+
            `<button class="ts-preset" data-pre-ren="${ui}" title="重新命名，或是將它移入/移出資料夾">改名 / 移動</button>`+
            `<button class="ts-preset" data-pre-del="${ui}" style="color:var(--red,#e66)">刪除</button>`)+
        `</div>`;
    };

    let itemsHtml = orphans.map(o => renderItem(o, false)).join('');
    for (const [g, entries] of groups) {
      itemsHtml += `<div style="display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--border);cursor:pointer;" onclick="if(event.target.closest('button'))return; const c=this.nextElementSibling; const e=c.style.display==='none'; c.style.display=e?'block':'none';">`+
        `<span style="font-size:14px;color:#ffca28;min-width:30px;text-align:center;">📁</span>`+
        `<span style="flex:1;font-size:14px;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHTML(g)}</span>`+
        `<button class="ts-preset" data-pre-ren-grp="${escapeHTML(g)}">改名</button>`+
        `<button class="ts-preset" data-pre-del-grp="${escapeHTML(g)}" style="color:var(--red,#e66)">刪除</button>`+
        `</div>`;
      itemsHtml += `<div style="margin-left:15px; padding-left:10px; border-left:1px solid #444; display:block;">` + entries.map(o => renderItem(o, true)).join('') + `</div>`;
    }

    body.innerHTML=`<div style="display:flex;justify-content:flex-end;gap:10px;margin-bottom:10px;padding:0 4px">`+
      `<button class="btn" id="preExportBtn" title="把自訂樣式存成 .json 檔">⭳ 匯出</button>`+
      `<button class="btn" id="preImportBtn" title="讀取 .json 檔並加入樣式庫">⭱ 匯入</button>`+
      `</div>`+
      `<div style="max-height:360px;overflow:auto;display:flex;flex-direction:column;gap:2px">`+
      itemsHtml +
      (getPresets().length?'':`<div style="color:var(--text-faint);font-size:12px;padding:10px 2px">尚未建立自訂樣式——在樣式面板調好後按「☆ 存為常用」即可新增。</div>`)+
      `</div>`;
  }
  const openPresetMgr = () => {
    const session = openModal('⚙ 常用樣式管理','',[{label:'關閉',primary:true,act:()=>session.close()}]);
    managerSession = session;
    _renderPresetMgr();
  };
  $('tsPresetMgr').addEventListener('click', openPresetMgr);
  /* 判準只有 substyle.js 的 styleMatchesPreset 一份（v5.9.1 起）。
     以前這裡自己寫一份、subtitles.js 另有兩份，靠註解維持同步；
     而那些註解指名的函式早就改名了，註解沒跟上——這正是為什麼不能靠註解。 */
  function _presetEditBegin(ui){
    const p=getPresets()[ui]; if(!p)return;
    const t=StylePanelController.styleTarget(); if(!t){ showToast('沒有字幕軌可用來編輯'); return; }
    const old=Object.assign({},STYLE_DEFAULTS,p.style||{});
    // 先掃出「進入編輯前就符合舊樣式」的軌與句——套上草稿之後就分不出來了
    const targets={ tracks:[], cues:[] };
    State.tracks.forEach((tk,i)=>{ if(tk && styleMatchesPreset(effStyle(null,tk),old)) targets.tracks.push(i); });
    for(const c of State.cues) if(c.style && Object.keys(c.style).length &&
      styleMatchesPreset(effStyle(c,State.tracks[c.track||0]||null),old)) targets.cues.push(c);
    State.presetEdit={ name:p.name, ui, trackIdx:t.i, targets, old, draft: Object.assign({}, old),
      ownerTracks:State.tracks, ownerCues:State.cues, trackOwners:State.tracks.slice(), preset:p };
    closeModal();
    $('tsEditBar').hidden=false; $('tsEditName').textContent=p.name;
    styleChanged();
  }
  function _presetEditEnd(save){
    const E=State.presetEdit; if(!E)return;
    if (!ownsDraft(E)) { revokeDraft(); styleChanged(); showToast('編輯對象已變更，已取消樣式草稿'); return; }
    const draft = E.draft;
    State.presetEdit=null; $('tsEditBar').hidden=true;      // 先清旗標，StylePanelController.styleTarget 才回正常行為
    if(!save || !draft){ styleChanged(); showToast('已取消編輯'); return; }
    const list=[...getPresets()]; const p=list[E.ui];
    if(p){ p.style=draft; savePresets(list); }
    // 同步：進入前就符合舊樣式的，一起換成新樣式
    let n=0;
    for(const i of E.targets.tracks){
      if(State.tracks[i] && !State.tracks[i].locked){ Object.assign(State.tracks[i],draft); n++; }
    }
    for(const c of E.targets.cues){
      if(!State.tracks[c.track||0]?.locked && applyCueStylePatch(c, draft)) n++;
    }
    styleChanged(); recordHistory('編輯常用樣式：'+E.name);
    showToast(`已更新「${E.name}」` + (n?`，同步 ${n} 處`:'（目前沒有套用它的字幕）'));
  }
  /* 直接呼叫上面那兩個函式。原本寫的是 State.presetEditEnd(...)，但 State 上
     【從來沒有】這兩個成員（全 repo 只有讀、沒有任何一處賦值），於是「完成」
     「取消」「修改參數」三顆按鈕一按就丟 TypeError。State 是無型別的物件袋、
     no-undef 也不檢查成員存取，app.js 又沒有測試，三道防線同時看不到。 */
  $('tsEditDone')?.addEventListener('click',()=>_presetEditEnd(true));
  $('tsEditCancel')?.addEventListener('click',()=>_presetEditEnd(false));
  $('tsEditPreviewText')?.addEventListener('input', () => { if(State.presetEdit) { renderVideoSub(); refreshMpvSubs(false, true); } });
  $('tsEditPreviewText')?.addEventListener('keydown', e => { e.stopPropagation(); });
  $('modalBody').addEventListener('click',async e=>{
    const owner = managerSession;
    if (!owner?.isCurrent()) return;
    const applyB=e.target.closest('[data-pre-apply]');
    const editB=e.target.closest('[data-pre-edit]');
    const renB=e.target.closest('[data-pre-ren]');
    const renGrpB=e.target.closest('[data-pre-ren-grp]');
    const delB=e.target.closest('[data-pre-del]');
    const delGrpB=e.target.closest('[data-pre-del-grp]');
    const expB=e.target.closest('#preExportBtn');
    const impB=e.target.closest('#preImportBtn');

    if(renGrpB) {
      const oldG = renGrpB.dataset.preRenGrp;
      const finish = save => {
        if (!session.isCurrent()) return;
        const newG = ($('__presetFolderRen')?.value || '').trim();
        if (save && newG && newG !== oldG) {
          const current = getPresets();
          const destinationKeys = new Set(current.filter(p => (p.group || '') !== oldG).map(presetIdentity));
          if (current.some(p => (p.group || '') === oldG && destinationKeys.has(presetIdentity({ ...p, group:newG })))) {
            showToast('目標資料夾已有同名樣式，請換個名稱');
            return;
          }
          const list = current.map(p => (p.group || '') === oldG ? { ...p, group:newG } : p);
          savePresets(list); StylePanelController.renderTrackStyle(); refreshStyleSummaries();
        }
        session.close({committed:true}); openPresetMgr();
      };
      const session = openModal('資料夾改名',
        `<label>新名稱<input id="__presetFolderRen" value="${escapeHTML(oldG)}"></label>`,
        [{label:'確定',primary:true,act:()=>finish(true)},{label:'取消',act:()=>finish(false)}],
        {onDismiss:openPresetMgr});
      return;
    }

    if(delGrpB){
      const grp = delGrpB.dataset.preDelGrp;
      if (confirm(`確定要刪除「${grp}」資料夾以及裡面所有的樣式嗎？\n\n（注意：刪除後無法復原）`)) {
        const l = getPresets().filter(p => p.group !== grp);
        savePresets(l); StylePanelController.renderTrackStyle(); _renderPresetMgr(); refreshStyleSummaries(); showToast('已刪除資料夾：' + grp);
      }
      return;
    }

    function _importPresets(j){
      if (!owner.isCurrent()) return;
      if(!Array.isArray(j)){ showToast('檔案格式不符：非樣式陣列'); return; }
      const list = [...getPresets()];
      let count = 0;
      validPresetList(j).forEach(p => {
        if(p.name && p.style && !isBuiltinPresetName(p.name)){
          const ex = list.findIndex(x=>presetIdentity(x)===presetIdentity(p));
          const imported = structuredClone(p);
          if(ex>=0) list[ex]=imported; else list.push(imported);
          count++;
        }
      });
      if(count>0){
        savePresets(list); _renderPresetMgr(); StylePanelController.renderTrackStyle(); refreshStyleSummaries();
        showToast(`已匯入 ${count} 組樣式`);
      }else{
        showToast('找不到可匯入的樣式');
      }
    }

    if(expB){
      const presets = getPresets(); // 只匯出自訂樣式
      if(!presets.length){ showToast('沒有自訂樣式可匯出'); return; }
      if (IS_DESKTOP && DESK.exportDirectory) {
        const files = presets.map(p => {
          // 淨化規則在 export-name-safety.js（跨行程契約的一側，見該檔頭註解）。
          // group 是匯入資料的顯示名稱，形狀驗證不會移除 "../.."；若把它直接
          // 傳給主程序的 path.join，正規化後可能跳出使用者
          // 選定的資料夾，把檔案寫到磁碟上任意位置。
          const str = JSON.stringify([p], null, 2);
          const bytes = new TextEncoder().encode(str);
          return { name: presetExportRelativePath(p), b64: bytesToB64(bytes) };
        });
        DESK.exportDirectory(files).then(dir => {
          if (owner.isCurrent() && dir) showToast('已匯出至：' + dir.split(/[\\/]/).pop());
        }).catch(error => { if(owner.isCurrent()) showToast('匯出失敗：' + error.message); });
      } else {
        const str = JSON.stringify(presets, null, 2);
        const bytes = new TextEncoder().encode(str);
        const name = `presets_${new Date().toISOString().replace(/\\D/g,'').slice(0,14)}.json`;
        downloadBytes(bytes, name, 'application/json'); showToast('已匯出樣式設定');
      }
      return;
    }
    if(impB){
      if(IS_DESKTOP && DESK.importDirectory){
        DESK.importDirectory().then(files => {
          if (!owner.isCurrent()) return;
          if(!files || !files.length) return;
          const all = [];
          for (const f of files) {
            try {
              const str = new TextDecoder().decode(b64ToBytes(f.b64));
              const j = JSON.parse(str);

              // Extract OS folder from path if it exists
              // f.name is a relative path like "My Folder/style.json"
              const parts = (f.name || '').replace(/\\/g, '/').split('/');
              const osFolder = parts.length > 1 ? parts[0] : null;

              const items = validPresetList(Array.isArray(j) ? j : [j]);
              items.forEach(p => {
                 if (osFolder) p.group = osFolder; // Map OS folder to UI folder
                 all.push(p);
              });
            } catch(e){}
          }
          if (all.length) _importPresets(all);
        }).catch(error => { if(owner.isCurrent()) showToast('匯入失敗：' + error.message); });
      }else{
        const fi=document.createElement('input'); fi.type='file'; fi.accept='.json'; fi.multiple=true;
        fi.onchange=async()=>{
          if (!owner.isCurrent()) return;
          if(!fi.files.length)return;
          const all = [];
          for (const f of Array.from(fi.files)) {
            try { const j = JSON.parse(await f.text()); if (Array.isArray(j)) all.push(...j); else all.push(j); } catch(e){}
            if (!owner.isCurrent()) return;
          }
          if (all.length) _importPresets(all);
        };
        fi.click();
      }
      return;
    }
    if(editB){ _presetEditBegin(+editB.dataset.preEdit); return; }
    if(applyB){ const p=getAllPresets()[+applyB.dataset.preApply]; const t=StylePanelController.styleTarget();
      if(p&&t){
        if(t.cues.length){
          for(const c of t.cues){
            applyCueStylePatch(c, p.style);
          }
        } else Object.assign(t.trk,p.style);
        styleChanged(); recordHistory('套用常用樣式：'+p.name); showToast('已套用：'+p.name); } return; }
    if(renB){
      const l=[...getPresets()], p=l[+renB.dataset.preRen]; if(!p)return;
      const update=capturePresetUpdate(p);
      const groups = [...new Set(l.filter(x=>x.group).map(x=>x.group))];
      const groupOpts = groups.map(g => `<option value="${escapeHTML(g)}">`).join('');

      const session = openModal('編輯名稱與資料夾',
        `<div style="font-size:13px;color:var(--text-dim);margin-bottom:4px">資料夾 (選填，可直接修改)</div>`+
        `<input type="text" id="__presetGroupRen" list="__presetGroupListRen" value="${escapeHTML(p.group||'')}" style="width:100%;margin-bottom:12px;padding:7px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:4px;">`+
        `<datalist id="__presetGroupListRen">${groupOpts}</datalist>`+
        `<div style="font-size:13px;color:var(--text-dim);margin-bottom:4px">樣式名稱</div>`+
        `<input type="text" id="__presetNameRen" value="${escapeHTML(p.name)}" style="width:100%;margin-bottom:12px;padding:7px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:4px;">`,
        [
          { label: '儲存', primary: true, act: () => {
            if (!session.isCurrent()) return;
            const nn = ($('__presetNameRen')?.value || '').trim();
            const ng = ($('__presetGroupRen')?.value || '').trim();
            if(!nn) { showToast('名稱不可為空'); return; }
            if(isBuiltinPresetName(nn)){ showToast('這是內建樣式的保留名稱，請換一個'); return; }

            const result=update({name:nn,group:ng});
            if(!result.ok){ showToast(result.reason==='name-conflict' ? '該資料夾中已有同名的樣式，請換一個名稱' : '樣式已變更，請重新開啟編輯'); return; }
            StylePanelController.renderTrackStyle(); refreshStyleSummaries();
            openPresetMgr(); // 重新開啟管理視窗
          }},
          { label: '取消', act: () => { if(session.isCurrent()) openPresetMgr(); } }
        ], { onDismiss:openPresetMgr }
      );
      setTimeout(() => { if(!session.isCurrent())return; const el = $('__presetNameRen'); if(el){ el.focus(); el.select(); } }, 30);
      return;
    }
    if(delB){ const l=[...getPresets()]; l.splice(+delB.dataset.preDel,1); savePresets(l); StylePanelController.renderTrackStyle(); _renderPresetMgr(); refreshStyleSummaries(); showToast('已刪除'); }
  });
  return syncDraft;
}

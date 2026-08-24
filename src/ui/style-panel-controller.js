import { $, sublist } from '../dom.js';
import { State, cueSuffix } from '../state.js';
import { effStyle, STYLE_DEFAULTS, CUE_STYLE_KEYS, getAllPresets, getPresets, getFonts, loadFonts, isBuiltinPresetName, savePresets, styleSnapshot } from '../substyle.js';
import { GEOMETRY_STYLE_KEYS, planCueStyleAssignment, planTrackStyleAssignment } from '../style-assignment.js';
import { applyCueStylePatch, applyTrackStylePlan } from '../style-commands.js';
import { recordHistory, syncCompareSnapshot } from '../history.js';
import { openModal, closeModal, showToast } from '../ui.js';
import { secToEncore } from '../time.js';
import { escapeHTML, clamp } from '../util.js';
import { Media } from '../media.js';
import { requestPointerSeek } from '../pointer-seek-control.js';
import { emit } from '../events.js';
import { ensureProjectSaved } from '../project.js';
import { editCue, splitCue } from '../subtitle-model.js';
import { showCtx, hideCtx } from '../menus.js';

let renderAll, renderVideoSub, refreshMpvSubs, drawTimeline, refreshStyleSummaries, initPresetLibrary, styleChanged;

State.presetEdit = null;
let _covCleared = false;


function styleTarget(){
  const i=State.listTrack, trk=State.tracks[i];
  if(!trk) return null;
  // 編輯常用樣式期間：攔截樣式目標，導向獨立的草稿 (draft)
  if(State.presetEdit) return { i: State.presetEdit.trackIdx, trk: State.presetEdit.draft, cues: [], cue: null };
  const ids=State.selectedIds && State.selectedIds.length ? State.selectedIds
          : (State.selectedId ? [State.selectedId] : []);
  const cues=ids.length ? State.cues.filter(c=>(c.track||0)===i && ids.includes(c.id)) : [];
  return { i, trk, cues, cue: cues[0] || null };
}

function renderTrackStyle(){
  const panel=$('trackStyle'); const t=styleTarget();
  if(!t){ panel.classList.add('disabled'); $('tsTitle').textContent='字幕樣式'; return; }
  panel.classList.remove('disabled');
  const { trk, cue, cues }=t;
  const idx=cue ? State.cues.filter(c=>(c.track||0)===State.listTrack).indexOf(cue)+1 : 0;
  const multi=cues.length>1;
  const editingPreset = State.presetEdit;
  const labelStr = editingPreset ? `✎ 編輯常用樣式：${editingPreset.name}`
                           : cue ? `第 ${idx} 句樣式` : `「${trk.name}」樣式`;
  $('tsTitle').textContent = labelStr;
  $('tsTitle').title = multi ? `改動會同時套用到選取的這 ${cues.length} 句（面板顯示的是第 ${idx} 句的值）`
                     : cue ? '改動只影響這一句；要套用到整軌請按「⇩ 全軌統一」'
                     : '沒有選取字幕 → 改動套用到整條軌道';
  panel.classList.toggle('per-cue', !!cue);
  const st=effStyle(cue, trk); // 生效值（缺欄位以預設後援）
  const setV=(id,v)=>{ const el=$(id); if(el&&document.activeElement!==el) el.value=v; };
  setV('tsSize',st.fontSize); setV('tsColor',(st.color||'#ffffff').toLowerCase());
  setV('tsPosX',(st.posX!=null?st.posX:STYLE_DEFAULTS.posX).toFixed(1)); setV('tsPosY',(st.posY!=null?st.posY:STYLE_DEFAULTS.posY).toFixed(1)); // 座標改為百分比呈現
  setV('tsAngle',st.angle);
  setV('tsOutline',st.outline); setV('tsOutlineColor',st.outlineColor); setV('tsShadow',st.shadow);
  setV('tsSpacing',st.letterSpacing); setV('tsLineSp',st.lineSpacing);
  setV('tsBgColor',st.bgColor); setV('tsBgAlpha',Math.round(st.bgAlpha*100));
  // 字型不在清單時動態補一個 option（舊專案存過已移除／改名的字型；不補的話下拉會顯示
  // 別的字型，看起來像被偷改）
  const fsel=$('tsFont');
  if(fsel){ if(![...fsel.options].some(o=>o.value===st.font||o.text===st.font)){
      const o=document.createElement('option'); o.text=st.font; o.value=st.font; fsel.appendChild(o); }
    if(document.activeElement!==fsel) fsel.value=st.font; }
  $('tsBold')?.classList.toggle('active',!!st.bold); $('tsItalic')?.classList.toggle('active',!!st.italic);
  $('tsVertical')?.classList.toggle('active',!!st.vertical); $('tsBgBox')?.classList.toggle('active',!!st.bgBox);
  panel.querySelectorAll('.ts-preset[data-ts-size]').forEach(b=>b.classList.toggle('active',+b.dataset.tsSize===st.fontSize));
  setV('tsAlign', st.align||'center'); setV('tsValign', st.valign||'bottom');
  // 底色未啟用時把色框/透明度變暗（消除「改了 bgColor 卻沒反應」的困惑——需先按「底」）
  const bgOn=!!st.bgBox; ['tsBgColor','tsBgAlpha'].forEach(id=>{ const el=$(id); if(el){ el.style.opacity=bgOn?'1':'.4'; el.title=(el.title||'').replace(/（未啟用.*$/,'')+(bgOn?'':'（未啟用：先按「底」）'); } });
  panel.querySelectorAll('.ts-clr').forEach(b=>b.classList.toggle('active',b.dataset.color===(st.color||'').toLowerCase()));
  // 常用樣式下拉重建
  const psel=$('tsPresetSel');
  if(psel){
    const cur=psel.value; 
    let html = '<option value="">— 套用 —</option>';
    const list = getAllPresets();
    const groups = {};
    const orphans = [];
    for (const p of list) {
      if (p.builtin) {
        orphans.push({ val: p.name, text: p.name });
        continue;
      }
      if (p.group) {
        if (!groups[p.group]) groups[p.group] = [];
        groups[p.group].push({ val: p.name, text: p.name });
      } else {
        orphans.push({ val: p.name, text: p.name });
      }
    }
    for (const o of orphans) html += `<option value="${escapeHTML(o.val)}">${escapeHTML(o.text)}</option>`;
    for (const g in groups) {
      html += `<optgroup label="📁 ${escapeHTML(g)}">`;
      for (const o of groups[g]) html += `<option value="${escapeHTML(o.val)}">${escapeHTML(o.text)}</option>`;
      html += `</optgroup>`;
    }
    psel.innerHTML = html; 
    psel.value=cur||''; 
  }
}

async function startInlineEdit(block,c){
  await ensureProjectSaved();
  hideCtx();
  const ed=document.createElement('textarea'); ed.className='cue-inline-edit'; ed.value=c.text||'';
  const r=block.getBoundingClientRect(), lr=$('tlLayer').getBoundingClientRect();
  ed.style.left=(r.left-lr.left)+'px'; ed.style.top=(r.top-lr.top)+'px';
  ed.style.width=Math.max(90,r.width)+'px'; ed.style.minHeight=r.height+'px';
  $('tlLayer').appendChild(ed); ed.focus(); ed.select();
  let done=false; const orig=c.text||'';
  const commit=(save)=>{
    if(done)return;
    done=true;
    const value=ed.value;
    ed.remove();
    if(save) editCue({ cueId:c.id, operation:'text', value, baseline:orig });
  };
  ed.addEventListener('keydown',ev=>{ ev.stopPropagation();
    if(ev.key==='Enter'&&!ev.shiftKey){ ev.preventDefault(); commit(true); }
    else if(ev.key==='Escape'){ ev.preventDefault(); commit(false); } });
  ed.addEventListener('blur',()=>commit(true));
  ed.addEventListener('mousedown',ev=>ev.stopPropagation());
  ed.addEventListener('dblclick',ev=>ev.stopPropagation());
}

async function openCueEditModal(c){
  await ensureProjectSaved();
  _covCleared=false;
  const orig=c.text||'';
  const trackIdx=c.track||0;
  const trackName=State.tracks[trackIdx]?.name||'';
  const tc=`${secToEncore(c.start,State.fps,State.dropFrame)} → ${secToEncore(c.end,State.fps,State.dropFrame)}`;

  // 找同 in 點的其他軌道字幕（容差 1 格）
  const TOL=1/Math.max(State.fps||25,1);
  const siblings=[];
  State.tracks.forEach((tk,i)=>{
    if(i===trackIdx)return;
    const match=State.cues.find(oc=>(oc.track||0)===i&&Math.abs(oc.start-c.start)<=TOL);
    if(match)siblings.push({trackName:tk.name,text:match.text||'',tkIdx:i});
  });

  const mkBlock=(label,text,btnId)=>
    `<div style="margin-bottom:12px">`+
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">`+
        `<span style="font-size:12px;color:var(--text-faint)">${label}</span>`+
        `<button id="${escapeHTML(btnId)}" style="font-size:11px;padding:1px 7px">複製</button>`+
      `</div>`+
      `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:8px 10px;min-height:2.2em">`+
        `<div id="${btnId==='cueEditCopy'?'cueEditOrig':''}" style="white-space:pre-wrap;font-size:14px;font-family:inherit;color:var(--text);user-select:text;cursor:text">${escapeHTML(text).replace(/\n/g, '<br>')}</div>`+
      `</div>`+
    `</div>`;

  const sibHtml=siblings.map(s=>mkBlock('軌道：'+s.trackName,s.text,'cueEditCopySib'+s.tkIdx)).join('');

  // v4.23 逐句樣式覆蓋：欄位定義（key, 標籤, 類型）——bool 用 select(開/關)、其餘勾選＋輸入
  const COV_FIELDS=[
    ['color','顏色','color'],['fontSize','字級','num'],['bold','粗體','bool'],['italic','斜體','bool'],
    ['outline','框線','num'],['outlineColor','框線色','color'],['shadow','陰影','num'],
    ['letterSpacing','字距','num'],['lineSpacing','行距','num'],['font','字型','text'],['vertical','直書','bool'],
  ];
  const effNow=effStyle(c, State.tracks[trackIdx]||null);
  const covRow=([k,label,type])=>{
    const has=!!(c.style&&c.style[k]!=null);
    const v=has?c.style[k]:effNow[k];
    let inp;
    if(type==='color') inp=`<input type="color" id="covV_${k}" value="${v}" style="width:26px;height:20px;padding:0">`;
    else if(type==='num') inp=`<input type="number" id="covV_${k}" value="${v}" step="${k==='lineSpacing'?0.1:0.5}" style="width:56px">`;
    else if(type==='bool') inp=`<select id="covV_${k}"><option value="1"${v?' selected':''}>開</option><option value="0"${!v?' selected':''}>關</option></select>`;
    else inp=`<input type="text" id="covV_${k}" value="${escapeHTML(String(v))}" style="width:90px">`;
    return `<label style="display:flex;align-items:center;gap:4px;white-space:nowrap"><input type="checkbox" id="covK_${k}"${has?' checked':''}>${label}</label>${inp}`;
  };
  const covHtml=
    `<details id="cueStyleOv"${c.style?' open':''} style="margin-top:10px;border:1px solid var(--border);border-radius:4px;padding:6px 8px">`+
    `<summary style="cursor:pointer;font-size:12px;color:var(--text-faint)">✱ 樣式覆蓋（僅此句；未勾選＝繼承軌道樣式）</summary>`+
    `<div style="display:grid;grid-template-columns:auto auto auto auto;gap:8px 14px;padding:10px 2px 4px;font-size:12px;align-items:center">`+
    COV_FIELDS.map(covRow).join('')+
    `</div><button id="covClear" style="font-size:11px;margin-top:6px">清除全部覆蓋</button></details>`;
  const doConfirm=()=>{
    const ta=$('cueEditTa');
    if(!ta) return;
    let val=ta.innerText;
    if(val.endsWith('\n') && !orig.endsWith('\n')) val=val.slice(0,-1);
    // 收集樣式覆蓋（勾選的欄位）。
    // ── 這裡是把 c.style【整個重建】，所以本視窗沒有控件的覆蓋欄位必須先原樣搬過來：
    //    座標／角度是在預覽窗拖出來的，這裡沒有對應欄位，不保留的話「開一下視窗按確定」
    //    就會把拖好的位置與角度默默清掉（angle 自 v4.27 起即有此問題）。
    //    使用者若要清掉它們，走「清除全部覆蓋」（見下方 covClear，會連同這些一起清）。
    const style={}; const origStyle=c.style?structuredClone(c.style):null;
    const managed=new Set(COV_FIELDS.map(f=>f[0]));
    if(c.style && !_covCleared) for(const k of CUE_STYLE_KEYS){ if(!managed.has(k) && c.style[k]!=null) style[k]=c.style[k]; }
    for(const [k,,type] of COV_FIELDS){
      const on=$('covK_'+k), vi=$('covV_'+k);
      if(!on||!on.checked||!vi) continue;
      style[k]= type==='num' ? +vi.value : type==='bool' ? (vi.value==='1') : vi.value;
    }
    const result=editCue({
      cueId:c.id,
      operation:'text-style',
      value:{ text:val, style:Object.keys(style).length?style:null },
      baseline:{ text:orig, style:origStyle },
    });
    if(result.ok) closeModal({committed:true});
  };
  openModal('修改字幕文字',
    `<div style="font-size:12px;color:var(--text-faint);margin-bottom:10px">${escapeHTML(trackName)} ｜ ${tc}</div>`+
    `<div style="max-height:58vh;overflow-y:auto;padding-right:2px">`+
    sibHtml+
    mkBlock('原文',orig,'cueEditCopy')+
    `<div style="font-size:12px;color:var(--text-faint);margin-bottom:4px">修改 <span style="font-size:10px;opacity:.5">（Enter 確認 · Shift+Enter 換行）</span></div>`+
    `<div id="cueEditTa" contenteditable="true" style="width:100%;min-height:5em;border:1px solid var(--border);border-radius:4px;background:var(--bg);font-size:14px;font-family:inherit;padding:6px;box-sizing:border-box;color:var(--text);overflow-y:auto;outline:none"></div>`+
    covHtml+
    `</div>`,
    [{label:'確認',primary:true,act:doConfirm},{label:'取消',act:closeModal}],
    { keepVideo:true }); // 對話框靠右停、遮罩透明、不隱藏 mpv → 編輯時看得到後面的畫面
  // seek 到這句的起點，讓後面顯示的正是這句對應的畫面（方便對著影像改字）
  try{ requestPointerSeek(c.start); }catch(e){}
  setTimeout(()=>{
    const ta=$('cueEditTa');
    if(ta){
      ta.dataset.orig=orig;
      ta.innerHTML=escapeHTML(orig).replace(/\n/g, '<br>');
      ta.focus();
      try { const r = document.createRange(), s = window.getSelection(); r.selectNodeContents(ta); s.removeAllRanges(); s.addRange(r); } catch (_) {}
      
      ta.addEventListener('keydown',e=>{
      // Enter 系列一律擋住冒泡：確認/切分會同步關閉 modal，若讓事件繼續傳到 window 的
      // 快捷鍵處理器，modal 已不在、同一下 Enter 會再觸發 toggle_play_pause 造成雙重動作
      if(e.key==='Enter') e.stopPropagation();
      if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){
        e.preventDefault();
        const sel=window.getSelection();
        if(!sel.rangeCount)return;
        const range=sel.getRangeAt(0).cloneRange();
        range.collapse(true);
        const MARK='\x01';
        const markerNode=document.createTextNode(MARK);
        range.insertNode(markerNode);
        let raw=ta.innerText;
        markerNode.parentNode.removeChild(markerNode);
        let markerPos=raw.indexOf(MARK);
        if(markerPos<0) markerPos=raw.length;
        let full=raw.replace(MARK,'');
        if(full.endsWith('\n')&&!orig.endsWith('\n')){
          full=full.slice(0,-1);
          if(markerPos>full.length) markerPos=full.length;
        }
        const textBefore=full.slice(0,markerPos);
        const textAfter=full.slice(markerPos);
        const result=splitCue({
          cueId:c.id,
          textBefore,
          textAfter,
          timelineTime:Media.displayTime(),
        });
        if(!result.ok)return;
        const nc=result.cue;
        closeModal({committed:true});
        setTimeout(()=>{
          const nr=sublist.querySelector(`.sub-row[data-id="${nc.id}"]`);
          if(nr)nr.dispatchEvent(new MouseEvent('dblclick',{bubbles:false,cancelable:true,view:window}));
        },30);
      } else if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doConfirm();}
    });
    }
    siblings.forEach(s=>{
      const btn=$('cueEditCopySib'+s.tkIdx);
      if(btn) btn.addEventListener('click',()=>{ navigator.clipboard.writeText(s.text).then(()=>{btn.textContent='已複製';setTimeout(()=>btn.textContent='複製',1500);}); });
    });
    const copyBtn=$('cueEditCopy');
    if(copyBtn) copyBtn.addEventListener('click',()=>{ navigator.clipboard.writeText(orig).then(()=>{copyBtn.textContent='已複製';setTimeout(()=>copyBtn.textContent='複製',1500);}); });
    // 樣式覆蓋區：清除鈕＋鍵盤事件不外洩（避免觸發全域快捷鍵）
    const ov=$('cueStyleOv');
    if(ov){
      ov.addEventListener('keydown',e=>e.stopPropagation());
      const cl=$('covClear');
      // 「清除全部覆蓋」＝連同本視窗沒有控件的座標／角度一起清（見存檔處的 _covCleared）
      if(cl) cl.addEventListener('click',e=>{ e.preventDefault(); _covCleared=true;
        ov.querySelectorAll('input[type=checkbox]').forEach(x=>x.checked=false); });
    }
  },30);
}


export function bindStylePanelEvents(deps) {
  renderAll = deps.renderAll;
  renderVideoSub = deps.renderVideoSub;
  refreshMpvSubs = deps.refreshMpvSubs;
  drawTimeline = deps.drawTimeline;
  refreshStyleSummaries = deps.refreshStyleSummaries;
  styleChanged = deps.styleChanged;
  initPresetLibrary = deps.initPresetLibrary;

let _tsSetTimer = null;
  const tsSet=(k,v)=>{
    const t=styleTarget(); if(!t)return;
    const changed = t.cues.length
      ? t.cues.reduce((anyChanged, cue) => applyCueStylePatch(cue, { [k]: v }) || anyChanged, false)
      : t.trk[k] !== v;
    if(!t.cues.length && changed) t.trk[k]=v;
    if(!changed) return;
    styleChanged();
    // 樣式 history 會合併 500ms 內的輸入，但 compare 的 snapshot 不能等到那時；
    // 否則舊視窗的 stable-ID command 會在這段空窗套到已改過的 project 上。
    syncCompareSnapshot();
    clearTimeout(_tsSetTimer);
    _tsSetTimer = setTimeout(() => recordHistory('修改字幕樣式', { sync: false }), 500);
  };
  $('tsSize').addEventListener('input',e=>tsSet('fontSize', clamp(+e.target.value,10,300)));
  $('tsSize').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} });
  // 座標改為直接輸入百分比
  ['tsPosX','tsPosY'].forEach(id=>{
    const isX = id==='tsPosX', key = isX ? 'posX' : 'posY';
    $(id).addEventListener('input',e=>{
      tsSet(key, clamp(+e.target.value, 0, 100));
    });
    $(id).addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} });
  });
  $('tsColor').addEventListener('input',e=>tsSet('color', e.target.value));
  const tsNum=(id,k,lo,hi)=>{ const el=$(id); if(!el)return;
    el.addEventListener('input',e=>tsSet(k, clamp(+e.target.value, lo, hi)));
    el.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} }); };
  const tsToggle=(id,k)=>{ const el=$(id); if(!el)return;
    el.addEventListener('click',()=>{ const t=styleTarget(); if(!t)return; tsSet(k, !effStyle(t.cue, t.trk)[k]); }); };
  tsNum('tsOutline','outline',0,10); tsNum('tsShadow','shadow',0,10);
  tsNum('tsAngle','angle',-180,180); // 旋轉角度（度，順時針為正；繞錨點）
  tsNum('tsSpacing','letterSpacing',0,100); tsNum('tsLineSp','lineSpacing',1,100);
  $('tsOutlineColor').addEventListener('input',e=>tsSet('outlineColor',e.target.value));
  $('tsBgColor').addEventListener('input',e=>tsSet('bgColor',e.target.value));
  $('tsBgAlpha').addEventListener('input',e=>tsSet('bgAlpha', clamp(+e.target.value,0,100)/100));
  $('tsBgAlpha').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.target.blur();} });
  tsToggle('tsBold','bold'); tsToggle('tsItalic','italic');
  tsToggle('tsVertical','vertical'); tsToggle('tsBgBox','bgBox');
  // 字型只從 font/ 掃出來的清單選（v4.34.4 拿掉「自訂…」——手打系統字型名匯出時常配不到，
  // 見鐵律 §0.3；要多一個字型就往 font/ 放一個資料夾）
  $('tsFont').addEventListener('change', async e => {
    if (e.target.value === '__custom') {
      if (!window.subtool) {
        showToast('網頁版無法直接匯入字型檔案。請使用桌面版。');
        e.target.value = effStyle().font || STYLE_DEFAULTS.font;
        return;
      }
      const imported = await window.subtool.importFont();
      if (imported) {
        await loadFonts(true); // Reload fonts list
        // Update font select HTML
        const sel = $('tsFont');
        sel.innerHTML = getFonts().map(f=>`<option value="${escapeHTML(f.name)}">${escapeHTML(f.name)}</option>`).join('') + '<option value="__custom">匯入自訂字型...</option>';
        sel.value = imported;
        tsSet('font', imported);
        renderTrackStyle();
      } else {
        e.target.value = effStyle().font || STYLE_DEFAULTS.font;
      }
      return;
    }
    tsSet('font', e.target.value);
  });
  // 常用樣式庫：存 / 套用 / 管理（跨專案，存 config）
  // 存＝面板目前顯示的那組生效樣式（選取句 or 整軌）；套用＝同樣寫回面板當前的對象
  $('tsPresetSave').addEventListener('click',async()=>{
    const t=styleTarget(); if(!t)return;
    const curSt = effStyle(t.cue, t.trk);
    const isSameAsDefault = Object.keys(STYLE_DEFAULTS).every(k => 
      (STYLE_DEFAULTS[k]) === (curSt[k] != null ? curSt[k] : STYLE_DEFAULTS[k])
    );
    if (isSameAsDefault) {
      showToast('目前樣式與「預設」完全相同，無須儲存。');
      return;
    }
    
    function promptSaveModal(defGroup, defName) {
      return new Promise(resolve => {
        let done = false;
        const finish = (res) => { if(done)return; done = true; closeModal(); resolve(res); };
        
        const groups = [...new Set(getPresets().filter(p=>p.group).map(p=>p.group))];
        const groupOpts = groups.map(g => `<option value="${escapeHTML(g)}">`).join('');
        
        openModal('存為常用樣式',
          `<div style="font-size:13px;color:var(--text-dim);margin-bottom:4px">資料夾 (選填)</div>`+
          `<input type="text" id="__presetGroup" list="__presetGroupList" value="${escapeHTML(defGroup)}" style="width:100%;margin-bottom:12px;padding:7px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:4px;">`+
          `<datalist id="__presetGroupList">${groupOpts}</datalist>`+
          `<div style="font-size:13px;color:var(--text-dim);margin-bottom:4px">樣式名稱</div>`+
          `<input type="text" id="__presetName" value="${escapeHTML(defName)}" style="width:100%;margin-bottom:12px;padding:7px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:4px;">`,
          [
            { label: '儲存', primary: true, act: () => {
              const grp = ($('__presetGroup')?.value || '').trim();
              const nm = ($('__presetName')?.value || '').trim();
              if(!nm) { showToast('名稱不可為空'); return; }
              finish({ group: grp, name: nm });
            }},
            { label: '取消', act: () => finish(null) }
          ]
        );
        setTimeout(() => { const el = $('__presetName'); if(el){ el.focus(); el.select(); } }, 30);
      });
    }

    async function trySave(defGroup, defName) {
      const res = await promptSaveModal(defGroup, defName);
      if(!res) return;
      const { group: grp, name: nm } = res;
      if(isBuiltinPresetName(nm)){ showToast('這是內建樣式的保留名稱，請換一個'); return trySave(grp, defName); }
      
      const list=[...getPresets()];
      const exIdx = list.findIndex(p => p.name === nm && (p.group||'') === grp);
      
      const doSave = (finalGroup, finalName) => {
        const style=styleSnapshot(effStyle(t.cue, t.trk));
        const idx = list.findIndex(p => p.name === finalName && (p.group||'') === finalGroup);
        if(idx>=0) {
          list[idx] = Object.assign(list[idx], { name: finalName, group: finalGroup, style });
        } else {
          list.push({ name: finalName, group: finalGroup, style });
        }
        savePresets(list); renderTrackStyle(); refreshStyleSummaries(); showToast('已儲存常用樣式：'+finalName);
      };

      if(exIdx >= 0) {
        openModal('名稱已存在', `<div style="padding:6px 2px">「${escapeHTML(nm)}」已經存在此資料夾中，您要覆蓋現有的樣式，還是換別的名字？</div>`, [
          { label: '覆蓋', primary: true, act: () => { closeModal(); doSave(grp, nm); } },
          { label: '換別的名字', act: () => { closeModal(); trySave(grp, nm); } },
          { label: '取消', act: closeModal }
        ]);
      } else {
        doSave(grp, nm);
      }
    }
    
    trySave('', t.trk.name+' 樣式');
  });
  $('tsPresetSel').addEventListener('change',e=>{
    const t=styleTarget(), v=e.target.value; e.target.value='';
    if(!v||!t)return;
    const p=getAllPresets().find(x=>x.name===v); if(!p)return;
    const changed = t.cues.length
      ? t.cues.reduce((anyChanged, cue) => applyCueStylePatch(cue, p.style) || anyChanged, false)
      : Object.keys(p.style || {}).some(key => t.trk[key] !== p.style[key]);
    if(!t.cues.length && changed) Object.assign(t.trk, p.style);
    if(!changed) return;
    styleChanged(); recordHistory('套用常用樣式：'+v);
  });
  /* 常用樣式庫（管理視窗、編輯模式、匯入匯出）：見 initPresetLibrary()。
     這一段與樣式面板的接線互不相干，抽出來讓 initUI 只剩面板本身。 */
  initPresetLibrary();
  /* 全軌統一：清掉本軌所有「逐句樣式覆蓋」，讓每句都回到軌道樣式。
     ── 軌道樣式本來就是全軌生效；唯一會脫隊的就是設過覆蓋的句子（列表標 ✱ 自訂）。
        本鈕＝那些句子的一鍵歸隊，而非「把樣式複製到每一句」。 */
  $('tsUnify')?.addEventListener('click',()=>{
    const t=styleTarget(); if(!t)return;
    const { i, trk, cue }=t;
    const others=State.cues.filter(c=>(c.track||0)===i && c!==cue);
    const ovs=others.filter(c=>c.style && Object.keys(c.style).length).length;
    const st=effStyle(cue, trk);
    const idx=cue ? State.cues.filter(c=>(c.track||0)===i).indexOf(cue)+1 : 0;
    const 來源 = cue ? `第 ${idx} 句` : '目前';
    if(!others.length){ showToast('本軌只有這一句'); return; }
    openModal('全軌套用', `<div style="font-size:13px;line-height:1.7">`+
      `把<b style="color:var(--accent)">${來源}的樣式</b>套用到「${escapeHTML(trk.name)}」的<b>全部 ${others.length+ (cue?1:0)} 句</b>。<br>`+
      (ovs ? `其中 <b style="color:var(--accent)">${ovs}</b> 句原本設過自己的樣式，會一併被覆蓋。<br>` : '')+
      `<span style="color:var(--text-faint)">位置與角度也會一起套用（可 <b>Ctrl+Z</b> 復原）。</span></div>`,
       [{label:'取消',act:closeModal},{label:`套用到全部 ${others.length+(cue?1:0)} 句`,primary:true,act:()=>{
         closeModal();
         const trackCues = State.cues.filter(c => (c.track||0)===i);
         // 生效樣式寫進軌道共同基準，逐句 override 由同一份 plan 最小化。
         applyTrackStylePlan(trk, trackCues, st);
         styleChanged(); drawTimeline(); // 摘要就地更新（捲動位置留在原處）；時間軸重畫掉 ✱ 標記
        recordHistory('全軌套用（'+來源+' → 全軌）');
        showToast('已把'+來源+'的樣式套用到整條軌道');
      }}]);
  });

  $('tsUnifyExclude')?.addEventListener('click',()=>{
    const t=styleTarget(); if(!t)return;
    const { i, trk, cue }=t;
    const others=State.cues.filter(c=>(c.track||0)===i && c!==cue);
    const ovs=others.filter(c=>c.style && Object.keys(c.style).length).length;
    const st=effStyle(cue, trk);
    const idx=cue ? State.cues.filter(c=>(c.track||0)===i).indexOf(cue)+1 : 0;
    const 來源 = cue ? `第 ${idx} 句` : '目前';
    if(!others.length){ showToast('本軌只有這一句'); return; }
    openModal('全軌套用-排除座標', `<div style="font-size:13px;line-height:1.7">`+
      `把<b style="color:var(--accent)">${來源}的樣式</b>套用到「${escapeHTML(trk.name)}」的<b>全部 ${others.length+ (cue?1:0)} 句</b>。<br>`+
      `（將排除座標與角度的變更）<br>`+
      (ovs ? `其中 <b style="color:var(--accent)">${ovs}</b> 句原本設過自己的樣式，會部分覆蓋。<br>` : '')+
      `<span style="color:var(--text-faint)">位置與角度會保持各句原本的設定（可 <b>Ctrl+Z</b> 復原）。</span></div>`,
       [{label:'取消',act:closeModal},{label:`套用到全部 ${others.length+(cue?1:0)} 句`,primary:true,act:()=>{
         closeModal();
         const trackCues = State.cues.filter(c => (c.track||0)===i);
         applyTrackStylePlan(trk, trackCues, st, GEOMETRY_STYLE_KEYS);

         styleChanged(); drawTimeline();
        recordHistory('全軌套用-排除座標（'+來源+' → 全軌）');
        showToast('已套用樣式（保留原座標與角度）');
      }}]);
  });
  // 大小快捷鈕 / 顏色色票 — 委派點擊；一律經 tsSet（選取句 or 整軌）
  $('trackStyle').addEventListener('click',e=>{
    const sz=e.target.closest('.ts-preset[data-ts-size]');
    if(sz){ tsSet('fontSize', +sz.dataset.tsSize); return; }
    const cl=e.target.closest('.ts-clr');
    if(cl) tsSet('color', cl.dataset.color);
  });
  // 對齊改下拉（v4.32.2）：左右／上下＝多行多句彼此的對齊方式；位置一律由 X/Y 數值決定
  $('tsAlign')?.addEventListener('change',e=>tsSet('align', e.target.value));
  $('tsValign')?.addEventListener('change',e=>tsSet('valign', e.target.value))
}

export const StylePanelController = {
  renderTrackStyle,
  styleTarget,
  openCueEditModal,
  startInlineEdit,
  bindStylePanelEvents
};

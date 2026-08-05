/* ==============================================================================
   v6.1.2 架構修正的真機驗收腳本
   ==============================================================================
   用法：桌面版開 DevTools（Ctrl+Shift+I）→ Console → 整段貼上 → Enter。
        建議先開一支素材、且字幕軌上至少有幾條字幕。

   【這支驗的是什麼】
   1115 個單元測試涵蓋純函式與資料完整性，但涵蓋不到「接線」——
   事件有沒有訂閱、按鈕按下去會不會丟例外、旗標有沒有真的被讀到。
   而這次改動有一整類風險是【以前是死的、現在會動】：
     - Wave.captureLive() 自 631f8e3 起就沒執行過
     - media-loader 的 streamIngest 分支每次都丟 TypeError 被吞掉
     - 四個事件訂閱、preset 編輯的三顆按鈕，以前都無作用
   這種東西壞掉時不會報錯，只會「沒反應」，肉眼看不出來。

   驗不到的：真正的畫面與聲音。那要靠匯出後用 ffprobe／抽格檢查（見輸出的提示）。
============================================================================== */
(async () => {
  const S = window.SUB;
  if (!S) { console.error('找不到 window.SUB —— 這不是 SUB Tool 的視窗，或 app 還沒初始化完成'); return; }

  const results = [];
  const ok = (name, pass, detail = '') => results.push({ name, pass, detail });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);

  /* ── 1. 事件匯流排：四條以前沒有訂閱者的邊 ───────────────────────────── */
  {
    // render:searchCount → #searchCount。以前 updateSearchCount() 零呼叫點，這個 span 永遠空白。
    const input = $('searchInput'), countEl = $('searchCount');
    if (!input || !countEl) {
      ok('搜尋計數', false, '找不到 #searchInput 或 #searchCount');
    } else if (!S.State.cues.length) {
      ok('搜尋計數', null, '略過：專案裡沒有字幕，請先載入或新增幾條再跑');
    } else {
      const term = (S.State.cues.find(c => (c.text || '').trim())?.text || '').trim().slice(0, 2);
      const before = countEl.textContent;
      input.value = term;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(120);
      ok('搜尋計數會更新（render:searchCount 有訂閱者）',
        countEl.textContent !== before && countEl.textContent.trim() !== '',
        `搜尋「${term}」→ #searchCount = "${countEl.textContent}"（原本 "${before}"）`);
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(80);
    }
  }

  /* ── 2. preset 編輯的三顆按鈕（以前一按就 TypeError） ─────────────────── */
  {
    const bar = $('tsEditBar'), done = $('tsEditDone'), cancel = $('tsEditCancel');
    if (!bar || !done || !cancel) {
      ok('preset 編輯列', false, '找不到 #tsEditBar / #tsEditDone / #tsEditCancel');
    } else {
      // 直接按「取消」：以前會丟 State.presetEditEnd is not a function
      let threw = null;
      const onErr = e => { threw = e.error || e.message; };
      window.addEventListener('error', onErr);
      cancel.click();
      await sleep(60);
      window.removeEventListener('error', onErr);
      ok('preset「取消」不再丟 TypeError', !threw, threw ? String(threw) : '無例外');
    }
  }

  /* ── 3. 焦點軌：類別與夥伴欄位必須一致 ───────────────────────────────── */
  {
    const gutters = [...document.querySelectorAll('.tl-gtrack[data-track]')];
    if (gutters.length < 2) {
      ok('焦點軌配對', null, `略過：只有 ${gutters.length} 條字幕軌，需要至少 2 條才驗得出切換`);
    } else {
      const target = gutters[gutters.length - 1];
      const wanted = +target.dataset.track;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(120);
      const pass = S.State.activeTrackKind === 'sub' && S.State.listTrack === wanted;
      ok('點軌道列頭後 activeTrackKind 與 listTrack 同步',
        pass, `activeTrackKind=${S.State.activeTrackKind}, listTrack=${S.State.listTrack}（點的是 ${wanted}）`);
      // 視覺上的 tl-active 也應該落在同一條
      const active = document.querySelector('.tl-gtrack.tl-active[data-track]');
      ok('軌道列頭的高亮與狀態一致',
        !!active && +active.dataset.track === wanted,
        active ? `高亮在軌 ${active.dataset.track}` : '沒有任何軌被高亮');
    }
  }

  /* ── 4. WebCodecs 接管旗標搬回 Media（以前讀到 undefined，mpvPresenting 永遠 true） ── */
  {
    const M = S.Media;
    const hasEntry = typeof M.webCodecsTakeover === 'function' && typeof M.setWebCodecsTakeover === 'function';
    ok('Media 有 webCodecsTakeover / setWebCodecsTakeover 公開入口', hasEntry);
    if (hasEntry) {
      const before = M.webCodecsTakeover();
      M.setWebCodecsTakeover(!before);
      const flipped = M.webCodecsTakeover() === !before;
      M.setWebCodecsTakeover(before); // 還原，不要留下副作用
      ok('接管旗標可讀可寫且回傳布林', flipped && typeof before === 'boolean',
        `初始=${before}，翻轉後讀回=${!before}`);
      ok('mpvPresenting() 不再永遠為 true（mpv 模式外應為 false）',
        M.mpvMode ? true : M.mpvPresenting() === false,
        `mpvMode=${M.mpvMode}, mpvPresenting()=${M.mpvPresenting()}`);
    }
  }

  /* ── 5. 三路一致：ASS 產出仍然正常（assAlignN 合併後值不可變） ─────────── */
  {
    try {
      const ass = S.toASSFromState(S.State.cues || []);
      const styleLines = (ass.match(/^Style: .*/gm) || []);
      ok('toASSFromState 仍產出 Style 行', styleLines.length > 0, `${styleLines.length} 條 Style`);
      // Alignment 是 V4+ 的第 19 欄；必須是 1-9
      const bad = styleLines.filter(l => {
        const n = +l.slice('Style: '.length).split(',')[18];
        return !(n >= 1 && n <= 9);
      });
      ok('Style 行的 Alignment 都在 1-9', bad.length === 0, bad[0] || '');
      // 這次刪掉了 toASS 的三個死參數；若順序寫錯，PlayRes 會變成預設 1000x562
      const pr = /PlayResX:\s*(\d+)[\s\S]*?PlayResY:\s*(\d+)/.exec(ass);
      ok('PlayRes 是 1920x1080（字幕畫布；不是 toASS 的預設 1000x562）',
        !!pr && pr[1] === '1920' && pr[2] === '1080',
        pr ? `PlayResX=${pr[1]}, PlayResY=${pr[2]}` : '找不到 PlayRes');
    } catch (e) {
      ok('toASSFromState 可執行', false, String(e));
    }
  }

  /* ── 6. 波形即時擷取（Wave.captureLive 以前是死碼） ──────────────────── */
  {
    const W = S.Wave;
    if (!W.live) {
      ok('即時波形', null, '略過：目前不是即時波形模式（只有長檔／無法解碼整段時才會啟用）');
    } else {
      const snapshot = W.peaks ? W.peaks.slice(0, 64) : null;
      ok('即時波形有緩衝區', !!snapshot);
      if (snapshot) {
        console.info('[提示] 請按播放約 2 秒後再執行：window.__vfyWave()');
        window.__vfyWave = () => {
          const now = W.peaks.slice(0, 64);
          const changed = now.some((v, i) => v !== snapshot[i]);
          console.log(changed
            ? '✅ 即時波形有在寫入（captureLive 已復活）'
            : '❌ 即時波形沒有變化 —— captureLive 可能仍然沒有執行');
        };
      }
    }
  }

  /* ── 輸出 ─────────────────────────────────────────────────────────────── */
  console.log('\n%c v6.1.2 接線驗收 ', 'background:#0f172a;color:#a7f3d0;font-weight:bold');
  let pass = 0, fail = 0, skip = 0;
  for (const r of results) {
    if (r.pass === null) { skip++; console.log('%c— 略過%c ' + r.name + (r.detail ? ' — ' + r.detail : ''), 'color:#94a3b8', ''); continue; }
    if (r.pass) { pass++; console.log('%c✅%c ' + r.name + (r.detail ? ' — ' + r.detail : ''), 'color:#059669', ''); }
    else { fail++; console.log('%c❌%c ' + r.name + (r.detail ? ' — ' + r.detail : ''), 'color:#dc2626;font-weight:bold', ''); }
  }
  console.log(`\n通過 ${pass} / 失敗 ${fail} / 略過 ${skip}`);
  if (fail) console.log('%c有失敗項 —— 那是「接線」斷了，不是計算錯了。先看對應的 emit/on 或 addEventListener。', 'color:#dc2626');
  console.log('\n這支驗不到畫面與聲音。匯出相關請照下面的 ffprobe 步驟另外驗。');
})();

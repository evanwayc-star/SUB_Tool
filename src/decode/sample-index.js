/* ==============================================================================
   SUB Tool — 樣本索引上的定位與位元組視窗（純函式）
   ==============================================================================

   WebCodecs 串流路只讀 mp4 檔頭的 moov 建出**樣本索引**
   `[{type,timestamp,duration,offset,size}]`，位元組則按需以 HTTP Range 抓。
   索引一旦建好，剩下的全是算術：

     - 目標時間落在哪個 GOP 的關鍵幀上（`keyIndexBefore`）
     - 一次該抓哪一段連續樣本（`windowStart` / `windowEnd`）
     - 那段對應的位元組區間與各樣本在其中的位移（`windowByteRange` / `sliceBounds`）
     - 視窗常駐幾個、誰先被丟掉（`touchWindow` / `evictWindows`）

   【為什麼抽出來】
   這些算式原本內聯在 demux.js 的 SampleReader 與 player.js 的 _keyBefore 裡，
   而那兩支都需要真的 mp4 位元組、`fetch`、`VideoDecoder` 才跑得起來——等於
   **完全沒有測試**。但它們的錯法都很安靜：二分搜尋差一格 → seek 到下一個 GOP
   的關鍵幀、播放點跳掉；位移算錯 → 餵給 decoder 的是別顆樣本的位元組，
   decoder 只會吐出花畫面或什麼都不吐。

   抽成純函式之後，測試餵**合成的索引陣列**就行，不必把 mp4 樣本檔放進版控。
============================================================================== */

/* 視窗同時受樣本數與位元組數上限拘束——長 GOP／高位元率的原生檔，
   48 顆樣本可能是好幾十 MB。 */
export const WIN_SAMPLES = 48;            // ≈2s @24fps（proxy 短 GOP 每 0.5s 一個關鍵幀）
export const WIN_BYTES = 4 * 1024 * 1024;
export const WIN_KEEP = 4;                // 常駐視窗數（≈16MB 上限）

/**
 * 目標時間所屬 GOP 的關鍵幀樣本索引。
 *
 * 在 `keyIdx`（關鍵幀的樣本序號，遞增）上二分搜尋——每幀每層都要問一次，
 * 長片（2 小時＝17 萬顆樣本）逐顆線性掃會直接吃掉整個 frame budget。
 *
 * 目標早於第一個關鍵幀時回第一個關鍵幀（不能回 −1：那會讓 fedIdx 變負數）。
 *
 * @param {Array}  index  樣本索引
 * @param {number[]} keyIdx 關鍵幀在 index 中的位置
 * @param {number} tUs    目標時間（微秒）
 */
export function keyIndexBefore(index, keyIdx, tUs) {
  let lo = 0, hi = keyIdx.length - 1, k = keyIdx[0];
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (index[keyIdx[m]].timestamp <= tUs) { k = keyIdx[m]; lo = m + 1; }
    else hi = m - 1;
  }
  return k;
}

/**
 * 格線起點。視窗對齊到固定格線，**不是**「以 i 為首」——
 * 各層的解碼游標各自不同，對齊後才能共用同一批視窗；
 * 否則兩層差一顆樣本就會各抓一份幾乎相同的位元組。
 */
export function gridStart(i, winSamples = WIN_SAMPLES) {
  return Math.floor(i / winSamples) * winSamples;
}

/** 從 `from` 起、不超過 `limit`、累計位元組不超過 `winBytes` 的終點（不含）。 */
function endWithin(index, from, limit, winBytes) {
  let to = limit;
  const base = index[from].offset;
  for (let i = from + 1; i < to; i++) {
    if (index[i].offset + index[i].size - base > winBytes) { to = i; break; }
  }
  /* 至少收一顆。兩個理由，第二個比較嚴重：
     ① 單顆樣本自己就超過 winBytes 時仍須抓得動，否則那顆永遠讀不到、播放停在該處；
     ② planWindow 的迴圈靠「to > from」才會收斂——回傳空視窗會讓它無限迴圈，
        整個分頁當掉。這條不變量由 tests/sampleIndex.test.js 直接守住。 */
  return Math.max(to, from + 1);
}

/**
 * 視窗終點（不含）。從**格線起點** `from` 起最多 `winSamples` 顆，
 * 且累計位元組不超過 `winBytes`。
 */
export function windowEnd(index, from, { winSamples = WIN_SAMPLES, winBytes = WIN_BYTES } = {}) {
  return endWithin(index, from, Math.min(from + winSamples, index.length), winBytes);
}

/**
 * 樣本 i 所屬的視窗 `{from, to}`（to 不含）。**這是唯一該用來決定視窗的入口。**
 *
 * 【為什麼不能只用 gridStart】
 * 位元組上限可能讓一個格子被切成好幾段：每顆樣本 1MB 的高位元率原生檔，
 * 格子有 48 顆、但 4MB 只裝得下 4 顆。舊寫法拿 `gridStart(i)` 當視窗的鍵，
 * 於是樣本 4…47 全部指向鍵 0——而鍵 0 的視窗只涵蓋 [0,4)。
 * `ensure()` 查到鍵 0 已存在就直接返回，那些樣本的位元組**永遠不會被抓**，
 * `data()` 永遠回 null → 該層預覽就停在那一格畫面上，不報錯也不恢復。
 *
 * 所以格子被切斷時，後續視窗從切斷處接著算，直到涵蓋 i 為止。
 * 沒被切斷的常見情形（proxy 檔 48 顆 ≈ 1MB）一次就回格線起點，共用行為不變。
 */
export function planWindow(index, i, { winSamples = WIN_SAMPLES, winBytes = WIN_BYTES } = {}) {
  const cellEnd = Math.min(gridStart(i, winSamples) + winSamples, index.length);
  let from = gridStart(i, winSamples);
  for (;;) {
    const to = endWithin(index, from, cellEnd, winBytes);
    if (i < to) return { from, to };
    from = to;   // 被位元組上限截斷 → 下一段從截斷處接續（to 恆 > from，必定收斂）
  }
}

/**
 * 視窗要抓的位元組區間 `{base, end}`（end 不含）。
 *
 * `end` 夾到 `maxEnd`（＝索引裡最大的 offset+size）：mp4 的 mdat 之後可能還有
 * moov／free 之類的 box，多抓沒有意義，而且有些來源對超出檔尾的 Range 會回 416。
 */
export function windowByteRange(index, from, to, maxEnd) {
  const last = index[to - 1];
  return { base: index[from].offset, end: Math.min(last.offset + last.size, maxEnd) };
}

/**
 * 樣本 i 的位元組在視窗 `win`（含 from／to／base）內的位置；不在這個視窗裡回 null。
 *
 * 位移是 `offset − base` 而不是把樣本大小累加起來——樣本在 mdat 裡未必連續
 * （交錯的音訊樣本就夾在中間），累加會整段偏掉。
 */
export function sliceBounds(index, i, win) {
  if (!win || i < win.from || i >= win.to) return null;
  const s = index[i];
  const off = s.offset - win.base;
  return { off, end: off + s.size };
}

/** LRU：把 from 移到最新。回傳新的順序陣列（原陣列不動）。 */
export function touchWindow(order, from) {
  const k = order.indexOf(from);
  if (k < 0) return order.slice();
  const next = order.slice();
  next.splice(k, 1);
  next.push(from);
  return next;
}

/**
 * 超出常駐上限的視窗（最舊的先丟）。回 `{ keep, drop }`。
 * 丟掉的只是位元組，索引本身永遠留著——重新播到那裡再抓一次即可。
 */
export function evictWindows(order, keep = WIN_KEEP) {
  if (order.length <= keep) return { keep: order.slice(), drop: [] };
  const cut = order.length - keep;
  return { keep: order.slice(cut), drop: order.slice(0, cut) };
}

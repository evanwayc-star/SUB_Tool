/* SUB Tool — 說明 / 快捷鍵對話框（純內容） */
import { openModal } from './ui.js';

function showHelp(){
  openModal('鍵盤快捷鍵 / 使用說明',
  `<b>三大區塊</b>：播放窗（左上）· 字幕列表（右）· 時間軸（下）。<br>`+
  `<b>上字幕流程</b>：選一條字幕 → 播到開始處按 <kbd>I</kbd>、播到結束處按 <kbd>O</kbd>。<br><br>`+
  `<b>▍播放控制</b>
  <table class="keys">
   <tr><td><kbd>Space</kbd></td><td>播放 / 暫停</td></tr>
   <tr><td><kbd>J</kbd></td><td>倒帶（每按一次加速：1× → 1.5× → 2× → 2.5× → 3×，到頂維持 3×）</td></tr>
   <tr><td><kbd>K</kbd></td><td>停止 / 暫停</td></tr>
   <tr><td><kbd>L</kbd></td><td>正播加速（1× → 1.5× → 2× → 2.5× → 3×，到頂維持 3×）</td></tr>
   <tr><td><kbd>←</kbd> / <kbd>→</kbd></td><td>前 / 後一格</td></tr>
   <tr><td><kbd>Shift</kbd>+<kbd>←</kbd><kbd>→</kbd></td><td>前 / 後 1 秒</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>←</kbd><kbd>→</kbd></td><td>前 / 後 5 秒</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>←</kbd><kbd>→</kbd></td><td>跳到 上 / 下一個 備註點</td></tr>
   <tr><td>按住 <kbd>←</kbd> / <kbd>→</kbd></td><td>1× 速度連續倒帶 / 正播（放開停止）</td></tr>
   <tr><td><kbd>Home</kbd> / <kbd>Shift</kbd>+<kbd>↑</kbd></td><td>跳到開頭（00:00:00:00）</td></tr>
   <tr><td><kbd>End</kbd> / <kbd>Shift</kbd>+<kbd>↓</kbd></td><td>跳到片尾</td></tr>
  </table><br>`+
  `<b>▍字幕操作</b>
  <table class="keys">
   <tr><td><kbd>I</kbd></td><td>設定被選字幕的<b>起點</b>＝目前播放點（無選取則新增一條）</td></tr>
   <tr><td><kbd>O</kbd></td><td>設定被選字幕的<b>終點</b>＝目前播放點</td></tr>
   <tr><td><kbd>↑</kbd> / <kbd>↓</kbd></td><td>步進邊界點（起點 → 終點 → 下句起點…）</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>↑</kbd></td><td>跳到<b>上一句</b>起點並選取</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>↓</kbd></td><td>跳到<b>下一句</b>起點並選取</td></tr>
   <tr><td><kbd>Shift</kbd>+<kbd>Home</kbd></td><td>選取目前軌道<b>第一句</b>字幕，播放點跳到其起點</td></tr>
   <tr><td><kbd>Shift</kbd>+<kbd>End</kbd></td><td>選取目前軌道<b>最後一句</b>字幕，播放點跳到其起點</td></tr>
   <tr><td><kbd>P</kbd></td><td>將選取字幕整批位移到播放點</td></tr>
   <tr><td><kbd>Enter</kbd></td><td>開啟選取字幕的<b>文字編輯</b>視窗</td></tr>
   <tr><td><kbd>Del</kbd> / <kbd>Backspace</kbd></td><td>刪除選取（支援多選）</td></tr>
   <tr><td><kbd>Esc</kbd></td><td>取消所有選取 / 關閉上字幕模式</td></tr>
  </table><br>`+
  `<b>▍選取</b>
  <table class="keys">
   <tr><td><kbd>點選</kbd></td><td>選取單一字幕並跳到其起點；若已是單選且播放點在字幕範圍內，則不移動播放點</td></tr>
   <tr><td><kbd>Ctrl</kbd>+點</td><td>多選 / 取消單一</td></tr>
   <tr><td><kbd>Shift</kbd>+點</td><td>範圍選取（同軌道）</td></tr>
  </table><br>`+
  `<b>▍文字編輯（字幕列表內嵌 ＆ 編輯視窗）</b>
  <table class="keys">
   <tr><td><kbd>Enter</kbd></td><td>確認並離開編輯</td></tr>
   <tr><td><kbd>Shift</kbd>+<kbd>Enter</kbd></td><td>換行</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>Enter</kbd></td><td><b>拆分字幕</b>：游標前文字留在原句（out 點 = 播放點），游標後文字移至新句（in 點 = 播放點）；播放點須在字幕起訖範圍內</td></tr>
   <tr><td><kbd>Esc</kbd></td><td>取消 / 關閉視窗</td></tr>
  </table><br>`+
  `<b>▍時間碼輸入</b><br>`+
  `所有時間輸入欄（字幕起訖點、播放點時間碼）皆支援以下格式：
  <table class="keys">
   <tr><td><code>01:23:45:12</code></td><td>絕對時間碼（時:分:秒:格）</td></tr>
   <tr><td><code>1234512</code></td><td>緊湊格式，系統自動補位（= 01:23:45:12）</td></tr>
   <tr><td><code>+100</code></td><td>相對<b>加</b>：在原時間上加 1 秒（100 = 1秒0格）</td></tr>
   <tr><td><code>-200</code></td><td>相對<b>減</b>：在原時間上減 2 秒（結果不可早於 00:00:00:00）</td></tr>
  </table><br>`+
  `<b>▍其他快捷</b>
  <table class="keys">
   <tr><td><kbd>Ctrl</kbd>+<kbd>Z</kbd></td><td>復原</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></td><td>重做</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>儲存專案</td></tr>
   <tr><td><kbd>Ctrl</kbd>+<kbd>F</kbd></td><td>搜尋 / 取代</td></tr>
  </table><br>`+
  `<b>▍時間軸縮放</b>
  <table class="keys">
   <tr><td><kbd>-</kbd> / <kbd>=</kbd></td><td>縮小 / 放大（<kbd>Ctrl</kbd>+滾輪亦可）</td></tr>
   <tr><td><kbd>]</kbd></td><td>適配（顯示全部字幕）</td></tr>
   <tr><td><kbd>\\</kbd></td><td>適配（顯示完整影片長度）</td></tr>
  </table><br>`+
  `<b>▍介面說明</b><br>`+
  `<b>播放窗</b>：時間碼格式「時:分:秒:格」；<b>雙擊</b>時間數字可直接輸入（支援絕對時間碼或 +/- 相對位移）；<b>右鍵</b>時間數字可複製；畫面右鍵選音軌/速度；匯入影音時自動偵測 FPS（23.976/24/25/29.97/30）。<br>`+
  `<b>字幕列表</b>：上方下拉切換軌道；下方調整字幕大小／位置／顏色；<b>⬆＋ / ⬇＋</b> 在上/下方新增；右鍵選單可移軌道、調整選取範圍；雙擊字幕起訖時間碼可直接編輯（支援 +/- 相對位移）。<br>`+
  `<b>時間軸</b>：時間尺/波形區拖曳＝移動播放點；軌道空白區按住拖曳＝框選；拖字幕區塊＝移動（支援換軌、磁吸、防重疊）；拖邊緣＝調整起訖；雙擊字幕＝編輯文字；🔊 波形列右側下拉選單可切換顯示的音源聲道。<br>`+
  `<b>軌道</b>：＋軌道 新增、✕ 刪除、👁 顯示/隱藏；雙擊名稱改名；拖曳 ⠿ 重排順序；<b>拖曳軌道列或波形列底部邊框</b>可調整列高，雙擊邊框復位預設高度；匯出時多軌各自輸出獨立檔案。<br>`+
  `<b>🕘 紀錄 / 📌 備忘</b>：時間軸工具列開啟浮動面板；備忘可點時間跳轉；時間碼位移面板可對選取字幕批次加減時間。`);
}

export { showHelp };

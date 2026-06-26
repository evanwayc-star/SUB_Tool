/* SUB Tool — 基礎工具：數值 / 編碼 / 檔案（純邏輯，無跨模組相依） */
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const pad=(n,w=2)=>String(Math.floor(n)).padStart(w,'0');

/* 編碼：偵測並解碼 ArrayBuffer -> 字串 */
function decodeText(buf){
  const b=new Uint8Array(buf);
  if(b.length>=3 && b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF)
    return new TextDecoder('utf-8').decode(b.subarray(3));
  if(b.length>=2 && b[0]===0xFF&&b[1]===0xFE)
    return new TextDecoder('utf-16le').decode(b.subarray(2));
  if(b.length>=2 && b[0]===0xFE&&b[1]===0xFF)
    return new TextDecoder('utf-16be').decode(b.subarray(2));
  // 無 BOM：以零位元組分布猜測 UTF-16
  let zEven=0,zOdd=0,n=Math.min(b.length,4000);
  for(let i=0;i<n;i++){ if(b[i]===0){ (i%2===0)?zEven++:zOdd++; } }
  if(zOdd>n*0.15 && zOdd>zEven*3)  return new TextDecoder('utf-16le').decode(b);
  if(zEven>n*0.15 && zEven>zOdd*3) return new TextDecoder('utf-16be').decode(b);
  return new TextDecoder('utf-8').decode(b);
}
/* 編碼：字串 -> UTF-16 LE (含 BOM) Uint8Array */
function encodeUTF16LE(str){
  // 註解：此函式目前使用 charCodeAt 迭代，會將 Surrogate Pair（如 Emoji 或罕見漢字）拆分為兩個獨立的 16-bit 單位寫入。
  // 由於 JavaScript 的字串底層也是 UTF-16，因此直接將這兩個單位依序寫入位元組序列，
  // 儲存出來的檔案完全符合標準 UTF-16 LE，解碼時依然正確無誤，不需要改用 codePointAt 處理。
  const out=new Uint8Array(2+str.length*2);
  out[0]=0xFF; out[1]=0xFE;
  for(let i=0;i<str.length;i++){const c=str.charCodeAt(i); out[2+i*2]=c&0xFF; out[3+i*2]=(c>>8)&0xFF;}
  return out;
}
function downloadBytes(bytes,name,mime='application/octet-stream'){
  const blob=new Blob([bytes],{type:mime});
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if(isIOS){
    const reader = new FileReader();
    reader.onload = e => {
      const a = document.createElement('a');
      a.href = e.target.result; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
    };
    reader.readAsDataURL(blob);
    return;
  }
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function readFile(file){
  return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsArrayBuffer(file);});
}
function pickFile(inputEl){ return new Promise(res=>{
  inputEl.value=''; inputEl.onchange=()=>res(inputEl.files[0]||null); inputEl.click();
});}

function b64ToBytes(b64){const bin=atob(b64);const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u;}
function bytesToB64(bytes){let bin='';const ch=0x8000;for(let i=0;i<bytes.length;i+=ch)bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+ch));return btoa(bin);}
const baseName = p => (p||'').split(/[\\/]/).pop();
function escapeHTML(s){return s.replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}

/* 時間碼輸入框按鍵過濾：只允許數字與 : ; + -，以及編輯/導覽鍵與 Ctrl/Cmd 組合（複製貼上/全選）。
   其餘按鍵（字母 i/o 等）一律不接受 → 不打入字元、也不觸發任何動作。回傳 true=允許。 */
const _TC_NAV=['Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Tab','Enter','Escape'];
function tcKeyAllowed(e){
  if(e.ctrlKey||e.metaKey)return true;
  if(_TC_NAV.includes(e.key))return true;
  return !(e.key.length===1 && !/[0-9:;+\-]/.test(e.key));
}

export { clamp, pad, decodeText, encodeUTF16LE, downloadBytes, readFile, pickFile, b64ToBytes, bytesToB64, baseName, escapeHTML, tcKeyAllowed };

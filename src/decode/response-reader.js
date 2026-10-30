/* 媒體回應的 byte 預算由讀取 owner 執行，不能先 arrayBuffer() 再拒絕。
   Range 視窗與整檔 demux 退路共用此規則；Content-Length 僅供提前拒絕，
   不足以證明解壓後或未宣告長度的回應仍在預算內。 */
// 整檔 demux（預覽退路／診斷）使用同一預算；串流索引不受此限。
export const WHOLE_MEDIA_BYTE_LIMIT = 1500 * 1024 * 1024;

export async function readMediaBytes(response, limitBytes) {
  const cancelBody = async () => { try { await response.body?.cancel?.(); } catch (_) {} };
  if (!response.ok && response.status !== 206) {
    await cancelBody();
    throw new Error('取位元組失敗 HTTP ' + response.status);
  }
  const tooLarge = () => new RangeError(`媒體回應過大（讀取上限 ${limitBytes} bytes）`);
  if (Number(response.headers?.get?.('content-length')) > limitBytes) {
    await cancelBody();
    throw tooLarge();
  }
  // 標準 Fetch 的 null body 表示空回應；沒有串流能力不能保證有界讀取。
  if (response.body === null) return new ArrayBuffer(0);
  if (typeof response.body?.getReader !== 'function') throw new Error('媒體回應無法有界讀取');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limitBytes - total) throw tooLarge();
      chunks.push(value);
      total += value.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  } catch (error) {
    try { await reader.cancel(error); } catch (_) {}
    throw error;
  } finally { reader.releaseLock(); }
}

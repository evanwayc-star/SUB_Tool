import AlignmentWorker from './transcript-alignment-worker.js?worker&inline';
import { resolveRecognitionAlignment } from './transcript-alignment.js';

export function matchRecognitionTranscript({ signal, onProgress, ...input }) {
  if (signal?.aborted) return Promise.reject(new DOMException('已取消文本匹配', 'AbortError'));
  if (input.taskMode !== 'align' || typeof Worker === 'undefined') return resolveRecognitionAlignment(input);
  return new Promise((resolve, reject) => {
    const worker = new AlignmentWorker({ name:'subtool-transcript-alignment' });
    const finish = (callback, value) => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, new DOMException('已取消文本匹配', 'AbortError'));
    signal?.addEventListener('abort', abort, { once:true });
    worker.onmessage = ({ data }) => {
      if (Number.isFinite(data.progress)) onProgress?.(data.progress);
      else if (data.error) finish(reject, new Error(data.error));
      else finish(resolve, data.result);
    };
    worker.onerror = event => finish(reject, new Error(event.message || '文本匹配工作失敗'));
    try { worker.postMessage(input); } catch (error) { finish(reject, error); }
  });
}

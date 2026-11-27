'use strict';

const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

async function readWindow(executable, args, source, expected, limit, signal) {
  const file = await fs.open(source, 'r');
  try {
    if (identity(await file.stat({bigint:true})) !== expected) throw new Error('倒放期間母素材已變更');
    signal.throwIfAborted();
    const child = spawn(executable, args, { windowsHide:true, signal, stdio:['ignore','pipe','pipe',file.fd] });
    const chunks = [];
    let bytes = 0, diagnostic = '', failure;
    child.on('error',error=>{failure ||= error;});
    child.stderr.on('data',chunk=>{diagnostic = (diagnostic + chunk.toString()).slice(-4096);});
    child.stdout.on('data',chunk=>{
      bytes += chunk.length;
      if (bytes <= limit) chunks.push(chunk);
      else if (!failure) {
        failure = new Error('倒放解碼區塊超過預期大小');
        child.kill();
      }
    });
    const code = await new Promise(resolve=>child.once('close',resolve));
    if (failure) throw failure;
    if (code !== 0) throw new Error(`無法讀取倒放區塊：${diagnostic || code}`);
    if (identity(await file.stat({bigint:true})) !== expected || identity(await fs.stat(source,{bigint:true})) !== expected)
      throw new Error('倒放期間母素材已變更');
    return Buffer.concat(chunks,bytes);
  } finally { await file.close(); }
}

// Sample on the one absolute delivery grid. Each reader seeks with GOP preroll
// and emits its window in reverse order. The final writer owns timing, alpha
// gaps, composition and the complete audio stream.
async function pumpReverseFeeds(executable, feeds, pipes, signal) {
  let reader = Promise.resolve();
  const stop = new AbortController();
  const combined = AbortSignal.any([signal, stop.signal]);
  const closeInputs = () => { for (const pipe of pipes) pipe.destroy(); };
  combined.addEventListener('abort', closeInputs, { once: true });
  if (combined.aborted) closeInputs();
  async function pump(feed, pipe) {
    pipe.on('error', () => {}); // write/end callbacks below own errors.
    const expected = identity(await fs.stat(feed.source,{bigint:true}));
    const block = Math.max(1, Math.floor(feed.maxBytes / (feeds.length * feed.frameBytes)));
    for (let end = feed.samples; end > 0;) {
      combined.throwIfAborted();
      const start = Math.max(0, end - block), count = end - start;
      const seek = Math.max(0, feed.sourceFirst + start * feed.speed / feed.rate - .5);
      const vf = `${feed.cadence},trim=start_pts=${start}:end_pts=${end},${feed.scaleFilter},format=${feed.pixelFormat},reverse,setpts=PTS-STARTPTS`;
      const args = ['-hide_banner','-nostdin','-loglevel','error','-threads','1','-copyts','-start_at_zero',
        '-ss',seek.toFixed(6),'-noaccurate_seek','-fd','3','-i','fd:','-map','0:v:0','-an',
        '-filter_threads','1','-vf',vf,'-frames:v',String(count),'-fps_mode','passthrough',
        '-c:v','rawvideo','-threads:v','1','-pix_fmt',feed.pixelFormat,'-f','rawvideo','pipe:1'];
      // Only one window is decoded at a time. Release the reader slot before
      // draining the pipe: FFmpeg may be waiting to probe another input.
      const current = reader.then(() => {
        combined.throwIfAborted();
        return readWindow(executable, args, feed.source, expected, count * feed.frameBytes, combined);
      });
      reader = current.then(() => undefined, () => undefined);
      const stdout = await current;
      if (stdout.length % feed.frameBytes) throw new Error('倒放區塊未取得完整畫格');
      if (stdout.length) await new Promise((resolve, reject) =>
        pipe.write(stdout, error => error ? reject(error) : resolve()));
      end = start;
    }
    pipe.end();
  }
  let failed;
  await Promise.allSettled(feeds.map((feed, index) => pump(feed, pipes[index]).catch(error => {
    // The main FFmpeg can finish its requested trim while raw input is still
    // draining. Its own exit status remains authoritative in that case.
    if (['EPIPE', 'EOF', 'ERR_STREAM_DESTROYED'].includes(error.code)) return;
    if (!failed && !signal.aborted) failed = error;
    stop.abort();
  })));
  combined.removeEventListener('abort', closeInputs);
  if (failed) throw failed;
}

module.exports = { pumpReverseFeeds };

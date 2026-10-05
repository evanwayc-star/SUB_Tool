/* Full-source waveform coordinates; the separator never changes playback audio. */
export const VOCAL_SAMPLE_RATE = 44100;
export const VOCAL_RESOLUTION = 100;
export const MDX = Object.freeze({ nFft:7680, hop:1024, dimF:3072, dimT:256,
  chunk:261120, trim:3840, compensate:1.021 });

/** Public STFT + inference adapters. Pad every final window, including short audio. */
export async function separateStereo(channels, { stft, predict, onProgress = () => {} }) {
  const length=channels?.[0]?.length;
  if (!(channels?.[0] instanceof Float32Array) || !(channels?.[1] instanceof Float32Array) ||
      !length || channels[1].length!==length) throw new Error('人聲分離需要完整的立體聲 PCM');
  const valid=MDX.chunk-2*MDX.trim;
  const step=valid/2;
  const output=[new Float32Array(length),new Float32Array(length)];
  const weights=new Float32Array(length);
  for(let start=0;start<length;start+=step){
    const input=new Float32Array(MDX.chunk*2);
    const first=Math.max(0,start-MDX.trim);
    const last=Math.min(length,start+valid+MDX.trim);
    for(let ch=0;ch<2;ch++) input.set(channels[ch].subarray(first,last),ch*MDX.chunk+first-start+MDX.trim);
    const spectrum=stft.forward(input,1,MDX.chunk);
    const prediction=await predict(spectrum);
    if(!(prediction instanceof Float32Array)||prediction.length!==4*MDX.dimF*MDX.dimT)
      throw new Error('人聲分離模型輸出形狀不正確');
    const separated=stft.inverse(prediction,1);
    if(separated.length!==MDX.chunk*2) throw new Error('人聲分離音訊長度不正確');
    const count=Math.min(valid,length-start);
    for(let i=0;i<count;i++){
      // Smooth overlap without attenuating the first/last source samples.
      const weight=Math.max(1e-4,Math.min((i+1)/step,(valid-i)/step,1));
      weights[start+i]+=weight;
      for(let ch=0;ch<2;ch++) output[ch][start+i]+=separated[ch*MDX.chunk+MDX.trim+i]*weight*MDX.compensate;
    }
    onProgress(Math.min(1,(start+step)/length));
  }
  for(let i=0;i<length;i++) for(let ch=0;ch<2;ch++) output[ch][i]/=weights[i];
  return output;
}

/** Anti-alias FIR at the speech-model rate; preserve the original duration. */
export function speechMono16k(channels){
  const length=channels[0].length, ratio=VOCAL_SAMPLE_RATE/16000;
  // Dual-mono recordings can have opposite polarity. Do not let downmixing erase speech.
  const mono=new Float32Array(length);
  for(let first=0;first<length;first+=512){
    const last=Math.min(length,first+512);let left=0,right=0,mix=0;
    for(let i=first;i<last;i++){left+=channels[0][i]**2;right+=channels[1][i]**2;mix+=((channels[0][i]+channels[1][i])*.5)**2;}
    const cancelled=mix<(left+right)*.025;
    const dominant=left>=right?0:1;
    for(let i=first;i<last;i++)mono[i]=cancelled?channels[dominant][i]:(channels[0][i]+channels[1][i])*.5;
  }
  const out=new Float32Array(Math.ceil(length/ratio));
  const radius=12, cutoff=7200/VOCAL_SAMPLE_RATE;
  const phases=256;
  const kernels=Array.from({length:phases},(_,phase)=>{
    const kernel=new Float32Array(radius*2+1); let sum=0;
    for(let tap=-radius;tap<=radius;tap++){
      const x=tap-phase/phases;
      const sinc=x===0?2*cutoff:Math.sin(2*Math.PI*cutoff*x)/(Math.PI*x);
      const weight=sinc*(.5+.5*Math.cos(Math.PI*x/(radius+1)));
      kernel[tap+radius]=weight; sum+=weight;
    }
    for(let i=0;i<kernel.length;i++) kernel[i]/=sum;
    return kernel;
  });
  for(let i=0;i<out.length;i++){
    const at=i*ratio, base=Math.floor(at), kernel=kernels[Math.min(phases-1,Math.floor((at-base)*phases))];
    let sum=0;
    for(let tap=-radius;tap<=radius;tap++){
      const index=Math.max(0,Math.min(length-1,base+tap));
      sum+=mono[index]*kernel[tap+radius];
    }
    out[i]=sum;
  }
  return out;
}

/** Hysteresis plus onset/tail padding keeps subtitle cues and weak word endings. */
export function speechRanges(probabilities, duration){
  const ranges=[]; let start=null, silence=null;
  const frameSeconds=512/16000;
  for(let i=0;i<probabilities.length;i++){
    const time=i*frameSeconds, value=probabilities[i];
    if(start===null&&value>=.5){ start=time; silence=null; }
    if(start===null) continue;
    if(value>=.35){silence=null;continue;}
    silence??=time;
    if(time-silence>=.16){
      if(silence-start>=.096) ranges.push([Math.max(0,start-.08),Math.min(duration,silence+.12)]);
      start=null; silence=null;
    }
  }
  if(start!==null&&duration-start>=.096) ranges.push([Math.max(0,start-.08),duration]);
  // Padding may overlap; merge so the peak pass remains linear.
  return ranges.reduce((merged,range)=>{
    const last=merged.at(-1);
    if(last&&last[1]>=range[0]) last[1]=Math.max(last[1],range[1]); else merged.push(range);
    return merged;
  },[]);
}

/** Analyze only the requested center. Context is discarded at the exact source sample. */
export function vocalPeaks(channels,ranges,{offsetSamples=0,lengthSamples=channels[0].length-offsetSamples}={}){
  const buckets=Math.ceil(lengthSamples/(VOCAL_SAMPLE_RATE/VOCAL_RESOLUTION));
  const peaks=new Float32Array(buckets*2); let range=0;
  for(let bucket=0;bucket<buckets;bucket++){
    const first=offsetSamples+Math.floor(bucket*VOCAL_SAMPLE_RATE/VOCAL_RESOLUTION);
    const last=Math.min(offsetSamples+lengthSamples,offsetSamples+Math.floor((bucket+1)*VOCAL_SAMPLE_RATE/VOCAL_RESOLUTION));
    let min=0,max=0;
    for(let i=first;i<last;i++){
      const time=i/VOCAL_SAMPLE_RATE;
      while(range<ranges.length&&time>ranges[range][1]) range++;
      if(range>=ranges.length||time<ranges[range][0]) continue;
      for(let ch=0;ch<2;ch++){
        const value=channels[ch][i];
        if(!Number.isFinite(value)) throw new Error('人聲分離模型產生無效音訊');
        min=Math.min(min,value); max=Math.max(max,value);
      }
    }
    peaks[bucket*2]=min; peaks[bucket*2+1]=max;
  }
  return peaks;
}

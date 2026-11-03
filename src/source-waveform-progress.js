/* Only contiguous, persisted source samples may become visible waveform buckets. */
export function createSourceWaveformProgress({duration,resolution=100,owns=()=>true,publish=()=>{}}){
  const totalSamples=Math.round(duration*4000),samplesPerBucket=4000/resolution;
  let combined=null,sourceKey=null,completedSamples=0;
  return {
    get sourceKey(){return sourceKey;},
    get complete(){return completedSamples===totalSamples;},
    accept(data){
      if(!owns()||!data||!Number.isSafeInteger(totalSamples)||totalSamples<=0||totalSamples>2147483629
        ||!Number.isInteger(samplesPerBucket)||samplesPerBucket<1
        ||data.sampleRate!==4000||data.resolution!==resolution||data.totalSamples!==totalSamples
        ||typeof data.sourceKey!=='string'||!/^[a-f0-9]{16}$/.test(data.sourceKey)
        ||(sourceKey&&data.sourceKey!==sourceKey)
        ||data.startSample!==completedSamples||data.startSample%samplesPerBucket!==0
        ||!Number.isSafeInteger(data.completedSamples)||data.completedSamples<=completedSamples
        ||data.completedSamples>totalSamples
        ||(data.completedSamples!==totalSamples&&data.completedSamples%samplesPerBucket!==0)) return false;
      const peaks=data.peaks;
      if(!(peaks instanceof Float32Array)&&!Array.isArray(peaks)) return false;
      const first=data.startSample/samplesPerBucket,last=Math.ceil(data.completedSamples/samplesPerBucket);
      if(peaks.length!==(last-first)*2) return false;
      for(let i=0;i<peaks.length;i+=2){
        if(!Number.isFinite(peaks[i])||!Number.isFinite(peaks[i+1])||peaks[i]<-1||peaks[i]>0
          ||peaks[i+1]<0||peaks[i+1]>1) return false;
      }
      combined ||= new Float32Array(Math.ceil(totalSamples/samplesPerBucket)*2);
      combined.set(peaks,first*2);sourceKey=data.sourceKey;completedSamples=data.completedSamples;
      publish(combined.subarray(0,last*2));
      return owns();
    },
    verifyResult(result){
      if(!result?.wave||result.start!==0||!result.complete||!Number.isFinite(result.duration)
        ||Math.abs(result.duration-duration)>1/4000
        ||typeof result.sourceKey!=='string'||!/^[a-f0-9]{16}$/.test(result.sourceKey)
        ||(sourceKey&&result.sourceKey!==sourceKey)) throw new Error('連續波形的完成證據與來源不一致');
      return owns();
    },
  };
}

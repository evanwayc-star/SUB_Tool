import { resolveRecognitionAlignment, alignTranscriptToEvidence } from './transcript-alignment.js';

self.onmessage = ({ data }) => {
  try {
    const result = resolveRecognitionAlignment({ ...data, alignTranscriptToEvidence: options =>
      alignTranscriptToEvidence({ ...options, onProgress: progress => self.postMessage({ progress }) }) });
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};

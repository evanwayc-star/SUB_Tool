import { Project } from '../project.js';
import { Media } from '../media.js';

const AUDIO_MEDIA_EXTENSIONS = new Set(['aac','aif','aiff','alac','flac','m4a','mka','mp3','oga','ogg','opus','wav','wma']);

export function mediaFileKind(fileOrPath) {
  const name = typeof fileOrPath === 'string' ? fileOrPath : (fileOrPath?.name || '');
  const type = typeof fileOrPath === 'object' ? (fileOrPath?.type || '') : '';
  if (/^audio\//i.test(type)) return 'audio';
  if (/^video\//i.test(type)) return 'video';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['jpg','jpeg','png'].includes(ext) || /^image\//i.test(type)) return 'image';
  return AUDIO_MEDIA_EXTENSIONS.has(ext) ? 'audio' : 'video';
}

export function pickMediaFiles(input) {
  return new Promise(resolve => {
    input.value = '';
    input.onchange = () => resolve(Array.from(input.files || []));
    input.click();
  });
}

export async function importDesktopMediaFiles(value, explicitRelink = null) {
  const relink = explicitRelink || Project.pendingMediaRelink?.() || null;
  const projectRestore = relink?.plan || null;
  const paths = (Array.isArray(value) ? value : (value ? [value] : [])).filter(path => typeof path === 'string' && path);
  const videos = paths.filter(path => mediaFileKind(path) === 'video');
  const audios = paths.filter(path => mediaFileKind(path) === 'audio');
  const images = paths.filter(path => mediaFileKind(path) === 'image');
  let primaryLoaded = false;
  if (videos.length > 1) {
    if (!Media.seqOn()) { await Media.loadDesktopMedia(videos.shift(), projectRestore); primaryLoaded = true; }
    for (const path of videos) await Media.addClipDesktop(path);
  } else if (videos.length === 1) {
    const path = videos[0];
    if (Media.seqOn()) Media.openIncoming({ path });
    else { await Media.loadDesktopMedia(path, projectRestore); primaryLoaded = true; }
  }
  for (const path of audios) await Media.addAudioFileDesktop(path);
  for (const path of images) await Media.addImageDesktop(path);
  if (primaryLoaded && relink) await Project.finishMediaRelink(relink.generation, projectRestore);
}

export async function importBrowserMediaFiles(files, explicitRelink = null) {
  const relink = explicitRelink || Project.pendingMediaRelink?.() || null;
  const projectRestore = relink?.plan || null;
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const videos = list.filter(file => mediaFileKind(file) === 'video');
  const audios = list.filter(file => mediaFileKind(file) === 'audio');
  const images = list.filter(file => mediaFileKind(file) === 'image');
  let primaryLoaded = false;
  if (videos.length > 1) {
    if (!Media.seqOn()) { await Media.loadVideoFile(videos.shift(), projectRestore); primaryLoaded = true; }
    for (const file of videos) await Media.addClipWeb(file);
  } else if (videos.length === 1) {
    const file = videos[0];
    if (Media.seqOn()) Media.openIncoming({ file });
    else { await Media.loadVideoFile(file, projectRestore); primaryLoaded = true; }
  }
  for (const file of audios) await Media.addAudioFile(file);
  for (const file of images) await Media.addImageWeb(file);
  if (primaryLoaded && relink) await Project.finishMediaRelink(relink.generation, projectRestore);
}

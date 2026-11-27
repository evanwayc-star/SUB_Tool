//! v3.0 Multi-language, multi-slot, frame-accurate (`±1~2 frames`) subtitle extraction & batch queue pipeline.

use crate::credentials::{Provider, load_api_key_with_source, redact_secrets};
use crate::eval::evaluate_srt;
use crate::llm::{
    AUTO_GLOSSARY_SYSTEM_PROMPT, JsonRequest, LINE_REPAIR_SUFFIX, Part, TRANSLATE_SYSTEM_PROMPT,
    auto_glossary_schema, build_proofread_system_prompt, build_vision_system_prompt,
    generate_json_retry, parse_vision_events, proofread_schema, translate_schema, vision_schema,
};
use crate::pricing::{TokenUsage, USD_TO_TWD, compute_cost, estimate_run_cost};
use crate::srt::{SourceLang, SubtitleCue, clean_cue_text, write_srt};
use crate::stitcher::{WindowVisionRecord, char_similarity, normalize_text, stitch_dual_tracks};
use crate::video::{
    FrameTrack, WindowSpec, build_adaptive_sample_plan, probe_video, scan_full_fps_zones,
    stream_missing_windows,
};
use chrono::Utc;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Instant, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const VERSION: &str = "3.0.0-rust";
const VISION_ENGINE_VERSION: &str = "3.0.0";
const VISION_PROMPT_VERSION: &str = "variety-multislot-v3";
const PROOFREAD_VERSION: &str = "src-proofread-v3";
const AUTO_GLOSSARY_VERSION: &str = "auto-glossary-v1";
const TRANSLATE_PROMPT_VERSION: &str = "kvariety-card-zhTW-v2";
const WINDOW_SECONDS: f64 = 8.0;
const OVERLAP_SECONDS: f64 = 1.5;
const JPEG_QUALITY: u8 = 92;
const ESCALATE_FRAME_WIDTH: u32 = 1440;
const ESCALATE_REVIEW_POLICY: &str = "review-v2";
const TRANSLATE_BATCH_SIZE: usize = 30;
const PROOFREAD_BATCH_SIZE: usize = 50;

#[derive(Clone, Debug)]
pub struct RunConfig {
    pub video_path: PathBuf,
    pub output_dir: PathBuf,
    pub glossary_path: PathBuf,
    pub source_lang: SourceLang,
    pub provider: Provider,
    pub vision_model: String,
    pub translate_model: String,
    pub fps: f32,
    pub frame_width: u32,
    pub detail: String,
    pub workers: u32,
    pub translate_enabled: bool,
    pub smart_accuracy: bool,
    pub start: Option<f64>,
    pub duration: Option<f64>,
    pub auto_eval: bool,
}

#[derive(Clone, Debug)]
pub enum BackendEvent {
    Checkpoint {
        cues: Vec<SubtitleCue>,
        processed_end: f64,
    },
    Result {
        cues: Vec<SubtitleCue>,
        processed_end: f64,
    },
    JobStarted {
        job_index: usize,
        total_jobs: usize,
        output_dir: PathBuf,
    },
    Log(String),
    VisionProgress {
        job_index: usize,
        done: u32,
        total: u32,
        cost_usd: f64,
        cost_twd: f64,
    },
    TranslateProgress {
        job_index: usize,
        done: u32,
        total: u32,
    },
    TracksReady {
        output_dir: PathBuf,
    },
    EvalSummary {
        summary: String,
    },
    JobFinished {
        job_index: usize,
        ok: bool,
        output_dir: PathBuf,
        cost_usd: f64,
        cost_twd: f64,
    },
    BatchFinished {
        completed: usize,
        total: usize,
        total_usd: f64,
        total_twd: f64,
    },
}

pub fn locate_app_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let s = dir.to_string_lossy().to_lowercase();
        if (s.ends_with(r"\target\release") || s.ends_with(r"\target\debug"))
            && let Some(proj) = dir
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
        {
            return proj.to_path_buf();
        }
        return dir.to_path_buf();
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub fn find_default_video(app_dir: &Path) -> Option<PathBuf> {
    let mut dirs = vec![app_dir.to_path_buf()];
    if let Some(p) = app_dir.parent() {
        dirs.push(p.to_path_buf());
    }
    for d in &dirs {
        let cand = d.join("ST_JIMSSALABIUM_29.97fps_20FM.mp4");
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

fn find_eval_ref_dir(app_dir: &Path, video_path: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(vp) = video_path.parent() {
        candidates.push(vp.join("ST_JIMSSALABIUM_前五分鐘字幕"));
    }
    candidates.push(app_dir.join("ST_JIMSSALABIUM_前五分鐘字幕"));
    if let Some(p) = app_dir.parent() {
        candidates.push(p.join("ST_JIMSSALABIUM_前五分鐘字幕"));
    }
    candidates.into_iter().find(|d| d.is_dir())
}

fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("建立目錄失敗：{e}"))?;
    }
    let tmp = path.with_extension(format!(
        "json.{}.{:?}.tmp",
        std::process::id(),
        thread::current().id()
    ));
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp, format!("{text}\n")).map_err(|e| format!("寫入暫存檔失敗：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("寫入檔案失敗：{e}")
    })
}

fn append_jsonl(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", serde_json::to_string(value).unwrap_or_default());
    }
}

fn sha256_prefix20(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..20].to_string()
}

fn flagship_model_for(provider: Provider) -> &'static str {
    match provider {
        Provider::OpenAI => "gpt-5.4",
        Provider::Gemini => "gemini-2.5-pro",
    }
}

/// Spawn sequential batch queue execution across 1 or more videos.
pub fn spawn_batch_pipeline(
    app_dir: PathBuf,
    jobs: Vec<RunConfig>,
    cancel: Arc<AtomicBool>,
) -> Receiver<BackendEvent> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let total = jobs.len();
        let mut completed = 0_usize;
        let mut batch_usd = 0.0_f64;

        for (idx, cfg) in jobs.into_iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let out_dir = cfg.output_dir.clone();
            let _ = tx.send(BackendEvent::JobStarted {
                job_index: idx,
                total_jobs: total,
                output_dir: out_dir.clone(),
            });

            match execute_single_job(&app_dir, idx, total, &cfg, &cancel, &tx) {
                Ok(job_usd) => {
                    completed += 1;
                    batch_usd += job_usd;
                    let _ = tx.send(BackendEvent::JobFinished {
                        job_index: idx,
                        ok: true,
                        output_dir: out_dir,
                        cost_usd: job_usd,
                        cost_twd: job_usd * USD_TO_TWD,
                    });
                }
                Err(err) => {
                    let _ = tx.send(BackendEvent::Log(format!("[Error] {err}")));
                    let _ = tx.send(BackendEvent::JobFinished {
                        job_index: idx,
                        ok: false,
                        output_dir: out_dir,
                        cost_usd: 0.0,
                        cost_twd: 0.0,
                    });
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                }
            }
        }

        let _ = tx.send(BackendEvent::BatchFinished {
            completed,
            total,
            total_usd: batch_usd,
            total_twd: batch_usd * USD_TO_TWD,
        });
    });
    rx
}

fn vision_fingerprint(
    video_path: &Path,
    clip_start: f64,
    clip_end: f64,
    sample_count: usize,
    cfg: &RunConfig,
) -> Result<(String, Value), String> {
    let meta = fs::metadata(video_path).map_err(|e| format!("讀取影片中繼資料失敗：{e}"))?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_default();
    let canonical = fs::canonicalize(video_path).unwrap_or_else(|_| video_path.to_path_buf());
    let config = json!({
        "engine_version": VISION_ENGINE_VERSION,
        "prompt_version": VISION_PROMPT_VERSION,
        "source_lang": cfg.source_lang.code(),
        "video": canonical.to_string_lossy(),
        "video_size": meta.len(),
        "video_mtime_ns": mtime_ns,
        "clip_start": (clip_start * 10_000.0).round() / 10_000.0,
        "clip_end": (clip_end * 10_000.0).round() / 10_000.0,
        "sample_fps": cfg.fps,
        "sample_count": sample_count,
        "smart_accuracy": cfg.smart_accuracy,
        "window_seconds": WINDOW_SECONDS,
        "overlap_seconds": OVERLAP_SECONDS,
        "frame_width": cfg.frame_width,
        "jpeg_quality": JPEG_QUALITY,
        "detail": if cfg.provider == Provider::OpenAI { cfg.detail.as_str() } else { "default" },
        "provider": cfg.provider.as_str(),
        "model": cfg.vision_model,
    });
    let key = sha256_prefix20(&serde_json::to_string(&config).unwrap_or_default());
    Ok((key, config))
}

fn load_or_run_frame_track(
    video: &crate::video::VideoInfo,
    raw_start: f64,
    raw_end: f64,
    output_dir: &Path,
    cancel: &Arc<AtomicBool>,
    tx: &Sender<BackendEvent>,
) -> Result<FrameTrack, String> {
    let scan_cache_dir = output_dir.join("cache").join("frame_track");
    fs::create_dir_all(&scan_cache_dir).map_err(|e| format!("建立追蹤快取失敗：{e}"))?;
    let key = sha256_prefix20(&format!(
        "v3|{}|{:.4}|{:.4}|{:.3}",
        video.path.display(),
        raw_start,
        raw_end,
        video.fps
    ));
    let track_file = scan_cache_dir.join(format!("track_{key}.json"));
    if track_file.is_file()
        && let Ok(raw) = fs::read_to_string(&track_file)
        && let Ok(track) = serde_json::from_str::<FrameTrack>(&raw)
        && track.frame_count() > 0
    {
        let _ = tx.send(BackendEvent::Log(format!(
            "[Track] 載入本機 {:.2} FPS 全幀率分區追蹤快取（共 {} 格影格）",
            track.track_fps,
            track.frame_count()
        )));
        return Ok(track);
    }

    let t0 = Instant::now();
    let _ = tx.send(BackendEvent::Log(format!(
        "[Track] 啟動本機 {:.2} FPS 全幀率五分區追蹤（本機邊界估計與短暫字卡補取樣）...",
        crate::video::choose_track_fps(video.fps)
    )));
    let track = scan_full_fps_zones(video, raw_start, raw_end, cancel)?;
    if let Ok(val) = serde_json::to_value(&track) {
        let _ = atomic_write_json(&track_file, &val);
    }
    let _ = tx.send(BackendEvent::Log(format!(
        "[Track] 本機全幀率追蹤完成（耗時 {:.1}s，共 {} 格影格，步進 {:.1}ms）",
        t0.elapsed().as_secs_f64(),
        track.frame_count(),
        1000.0 / track.track_fps
    )));
    Ok(track)
}

fn combined_text_at_global_frame(rec: &WindowVisionRecord, g: usize) -> String {
    if g < rec.global_start || g > rec.global_end {
        return String::new();
    }
    let local = g - rec.global_start;
    rec.events
        .iter()
        .filter(|ev| ev.start_frame <= local && local <= ev.end_frame)
        .map(|ev| ev.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn clamp_cues(cues: Vec<SubtitleCue>, start: f64, end: f64) -> Vec<SubtitleCue> {
    cues.into_iter()
        .filter_map(|mut cue| {
            if !cue.start.is_finite() || !cue.end.is_finite() {
                return None;
            }
            cue.start = cue.start.max(start);
            cue.end = cue.end.min(end);
            if cue.end > cue.start && !cue.text.trim().is_empty() {
                Some(cue)
            } else {
                None
            }
        })
        .collect()
}

struct CheckpointPlan {
    windows: Vec<WindowSpec>,
    pts: Vec<f64>,
    indices: Vec<usize>,
    start: f64,
    end: f64,
    track: Option<FrameTrack>,
    sample_fps: f64,
}

impl CheckpointPlan {
    fn new(
        windows: &[WindowSpec],
        start: f64,
        end: f64,
        sample_fps: f64,
        track: Option<&FrameTrack>,
    ) -> Self {
        let count = windows.last().map(|w| w.global_end + 1).unwrap_or(0);
        let mut pts = vec![0.0; count];
        let mut indices = vec![0; count];
        for window in windows {
            for (local, (&time, &index)) in window
                .sample_times
                .iter()
                .zip(&window.track_indices)
                .enumerate()
            {
                pts[window.global_start + local] = time;
                indices[window.global_start + local] = index;
            }
        }
        Self {
            windows: windows.to_vec(),
            pts,
            indices,
            start,
            end,
            track: track.cloned(),
            sample_fps,
        }
    }

    fn snapshot(
        &self,
        records: &BTreeMap<usize, WindowVisionRecord>,
    ) -> Option<(Vec<SubtitleCue>, f64)> {
        let prefix: Vec<_> = self
            .windows
            .iter()
            .map_while(|w| records.get(&w.window_index).cloned())
            .collect();
        if prefix.is_empty() {
            return None;
        }
        // Only expose a contiguous, fully observed prefix. The unfinished overlap is kept for the next window.
        let end = self
            .windows
            .get(prefix.len())
            .and_then(|w| w.sample_times.first())
            .copied()
            .unwrap_or(self.end);
        let (mut cards, dialogue) = stitch_dual_tracks(
            &prefix,
            &self.pts,
            self.start,
            end,
            self.sample_fps,
            1,
            Some(&self.indices),
            self.track.as_ref(),
        );
        cards.extend(dialogue);
        cards = clamp_cues(cards, self.start, end);
        cards.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.end.total_cmp(&b.end)));
        Some((cards, end))
    }

    fn emit(&self, records: &BTreeMap<usize, WindowVisionRecord>, tx: &Sender<BackendEvent>) {
        if let Some((cues, processed_end)) = self.snapshot(records) {
            let _ = tx.send(BackendEvent::Checkpoint {
                cues,
                processed_end,
            });
        }
    }
}

fn find_hard_windows(records: &[WindowVisionRecord]) -> Vec<(usize, Option<String>, &'static str)> {
    let mut flagged: BTreeMap<usize, (u16, Option<String>, &'static str)> = BTreeMap::new();

    for rec in records {
        let local_max = rec.global_end.saturating_sub(rec.global_start);
        for ev in &rec.events {
            let has_profile_marker = [
                "자료제공",
                "@",
                "팔로워",
                "구독자",
                "유튜브",
                "提供",
                "チャンネル登録",
                "フォロワー",
            ]
            .iter()
            .any(|kw| ev.text.contains(kw));
            if has_profile_marker {
                flagged.insert(rec.window_index, (300, None, "社群／出處介紹圖卡"));
                break;
            }
            let span_len = ev.end_frame.saturating_sub(ev.start_frame) + 1;
            if local_max >= 10 && span_len >= local_max.saturating_sub(1) {
                flagged
                    .entry(rec.window_index)
                    .or_insert((220, None, "長時段字卡邊界複核"));
            }
            let non_ws = ev.text.chars().filter(|c| !c.is_whitespace()).count();
            let line_cnt = ev.text.lines().count();
            if non_ws >= 36 || line_cnt >= 4 {
                flagged
                    .entry(rec.window_index)
                    .or_insert((160, None, "高密度多行／滾動字卡"));
            }
        }
    }

    for pair in records.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        if b.global_start > a.global_end {
            continue;
        }
        let a_local_max = a.global_end.saturating_sub(a.global_start);
        let a_has_tail_runon = a.events.iter().any(|ev| {
            ev.end_frame >= a_local_max.saturating_sub(1)
                && ev.end_frame.saturating_sub(ev.start_frame) >= 7
        });
        let b_overlap_all_empty =
            (b.global_start..=a.global_end).all(|g| combined_text_at_global_frame(b, g).is_empty());

        if a_has_tail_runon && b_overlap_all_empty {
            flagged.insert(a.window_index, (290, None, "疑似結尾殘留延伸複核"));
            continue;
        }

        for g in b.global_start..=a.global_end {
            let ta = combined_text_at_global_frame(a, g);
            let tb = combined_text_at_global_frame(b, g);
            let na = normalize_text(&ta);
            let nb = normalize_text(&tb);
            if na.is_empty() && nb.is_empty() {
                continue;
            }
            if !na.is_empty() && !nb.is_empty() {
                let sim = char_similarity(&na, &nb);
                if sim < 0.80 {
                    let delta = na.chars().count().abs_diff(nb.chars().count()).min(60) as u16;
                    let prio = 200 + delta;
                    // Neither conflicting transcription is visual evidence for the other.
                    // Review both source windows without biasing either with the rival text.
                    flagged.insert(a.window_index, (prio, None, "跨視窗字卡不一致"));
                    flagged.insert(b.window_index, (prio, None, "跨視窗字卡不一致"));
                    break;
                }
            } else if g > b.global_start && g < a.global_end {
                if na.chars().count() >= 5 && nb.is_empty() {
                    if a_has_tail_runon {
                        flagged.insert(a.window_index, (285, None, "疑似結尾殘留延伸複核"));
                    } else {
                        flagged
                            .entry(b.window_index)
                            .or_insert((190, Some(ta), "重疊區漏檢複核"));
                    }
                    break;
                } else if nb.chars().count() >= 5 && na.is_empty() {
                    flagged
                        .entry(a.window_index)
                        .or_insert((190, None, "重疊區漏檢複核"));
                    break;
                }
            }
        }
    }

    flagged
        .into_iter()
        .map(|(w_idx, (_, hint, reason))| (w_idx, hint, reason))
        .collect()
}

fn needs_high_resolution_review(model: &str, flagship_model: &str, frame_width: u32) -> bool {
    model != flagship_model || frame_width < ESCALATE_FRAME_WIDTH
}

#[allow(clippy::too_many_arguments)]
fn run_vision_windows(
    job_index: usize,
    video: &crate::video::VideoInfo,
    target_windows: &[WindowSpec],
    hints: &HashMap<usize, String>,
    clip_start: f64,
    clip_end: f64,
    track_fps: f64,
    frame_track: Option<&FrameTrack>,
    sample_fps: f64,
    frame_width: u32,
    source_lang: SourceLang,
    provider: Provider,
    model: &str,
    detail: &str,
    workers: u32,
    api_key: &str,
    cache_dir: &Path,
    usage_log: &Path,
    stage_label: &str,
    base_cost_offset_usd: f64,
    cancel: &Arc<AtomicBool>,
    tx: &Sender<BackendEvent>,
) -> Result<(BTreeMap<usize, WindowVisionRecord>, TokenUsage), String> {
    fs::create_dir_all(cache_dir).map_err(|e| format!("建立快取目錄失敗：{e}"))?;

    let mut cached_map: BTreeMap<usize, WindowVisionRecord> = BTreeMap::new();
    let mut missing: Vec<WindowSpec> = Vec::new();
    let mut stage_usage = TokenUsage::default();

    for w in target_windows {
        let p = cache_dir.join(format!("win_{:05}.json", w.window_index));
        if p.is_file()
            && let Ok(raw) = fs::read_to_string(&p)
            && let Ok(rec) = serde_json::from_str::<WindowVisionRecord>(&raw)
            && rec.window_index == w.window_index
            && rec.global_start == w.global_start
            && rec.global_end == w.global_end
            && rec.actual_times == w.sample_times
        {
            stage_usage.add(&rec.usage);
            cached_map.insert(w.window_index, rec);
            continue;
        }
        missing.push(w.clone());
    }

    let total_targets = target_windows.len() as u32;
    let cached_count = cached_map.len() as u32;
    let checkpoint_plan = if stage_label == "Vision" {
        Some(Arc::new(CheckpointPlan::new(
            target_windows,
            clip_start,
            clip_end,
            sample_fps,
            frame_track,
        )))
    } else {
        None
    };
    if let Some(plan) = &checkpoint_plan {
        plan.emit(&cached_map, tx);
    }
    let _ = tx.send(BackendEvent::Log(format!(
        "[{stage_label}] 目標 {total_targets} 批關鍵幀視窗（快取命中 {cached_count}，待處理 {}）",
        missing.len()
    )));

    if missing.is_empty() {
        let c = compute_cost(model, &stage_usage);
        let usd = base_cost_offset_usd + c.usd;
        let _ = tx.send(BackendEvent::VisionProgress {
            job_index,
            done: total_targets,
            total: total_targets,
            cost_usd: usd,
            cost_twd: usd * USD_TO_TWD,
        });
        return Ok((cached_map, stage_usage));
    }

    let system_prompt = Arc::new(build_vision_system_prompt(source_lang));
    let num_workers = (workers as usize).clamp(1, missing.len().max(1));
    let (job_tx, job_rx) = mpsc::sync_channel::<(WindowSpec, Vec<Vec<u8>>)>(num_workers * 2);
    let shared_rx = Arc::new(Mutex::new(job_rx));
    let shared_results = Arc::new(Mutex::new(cached_map));
    let shared_usage = Arc::new(Mutex::new(stage_usage));
    let shared_done = Arc::new(Mutex::new(cached_count));
    let shared_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let log_lock = Arc::new(Mutex::new(()));

    let mut handles = Vec::with_capacity(num_workers);
    for _ in 0..num_workers {
        let rx_c = Arc::clone(&shared_rx);
        let res_c = Arc::clone(&shared_results);
        let usage_c = Arc::clone(&shared_usage);
        let done_c = Arc::clone(&shared_done);
        let err_c = Arc::clone(&shared_err);
        let log_c = Arc::clone(&log_lock);
        let cancel_c = Arc::clone(cancel);
        let sys_c = Arc::clone(&system_prompt);
        let tx_c = tx.clone();
        let cache_c = cache_dir.to_path_buf();
        let ulog_c = usage_log.to_path_buf();
        let api_key_c = api_key.to_string();
        let model_c = model.to_string();
        let detail_c = detail.to_string();
        let stage_c = stage_label.to_string();
        let hints_c = hints.clone();
        let checkpoint_c = checkpoint_plan.clone();

        handles.push(thread::spawn(move || {
            loop {
                if cancel_c.load(Ordering::Relaxed) {
                    break;
                }
                let job = {
                    let guard = rx_c.lock().unwrap();
                    guard.recv().ok()
                };
                let Some((win, jpegs)) = job else {
                    break;
                };
                if cancel_c.load(Ordering::Relaxed) {
                    break;
                }

                let t_win = Instant::now();
                let mut prompt = format!(
                    "Analyze these {} chronological keyframes (F00 to F{:02}). Extract every post-production subtitle/caption in its exact original language, assigning each independent region its `slot` and `kind` (`card` vs `dialogue`), and stopping `end_frame` at the exact last frame where the text is visibly present.",
                    jpegs.len(),
                    jpegs.len().saturating_sub(1)
                );
                if let Some(h) = hints_c.get(&win.window_index) {
                    let compact_h = h.replace('\n', " / ");
                    prompt.push_str(&format!(
                        "\nContinuity note: Preceding window ended with \"{compact_h}\". Check F00..F{:02} carefully so persistent stacked lines are not omitted.",
                        jpegs.len().saturating_sub(1)
                    ));
                }

                let mut parts = Vec::with_capacity(jpegs.len() + 1);
                parts.push(Part::Text(&prompt));
                for jpg in &jpegs {
                    parts.push(Part::Jpeg(jpg));
                }
                let req = JsonRequest {
                    provider,
                    api_key: &api_key_c,
                    model: &model_c,
                    system: &sys_c,
                    parts,
                    schema: vision_schema(),
                    schema_name: "variety_multislot_events",
                    max_output_tokens: 2800,
                    temperature: 0.0,
                    detail: &detail_c,
                };

                match generate_json_retry(&req, &cancel_c, 4) {
                    Ok((val, usage)) => match parse_vision_events(&val, jpegs.len()) {
                        Ok((det_lang, events)) => {
                            let ev_count = events.len();
                            let rec = WindowVisionRecord {
                                window_index: win.window_index,
                                global_start: win.global_start,
                                global_end: win.global_end,
                                actual_times: win.sample_times.clone(),
                                detected_language: det_lang,
                                events,
                                usage: usage.clone(),
                                elapsed_seconds: (t_win.elapsed().as_secs_f64() * 100.0).round()
                                    / 100.0,
                                provider: provider.as_str().to_string(),
                                model: model_c.clone(),
                            };
                            let win_file = cache_c.join(format!("win_{:05}.json", win.window_index));
                            if let Ok(v) = serde_json::to_value(&rec) {
                                let _ = atomic_write_json(&win_file, &v);
                            }
                            {
                                let _g = log_c.lock().unwrap();
                                append_jsonl(
                                    &ulog_c,
                                    &json!({
                                        "utc": Utc::now().to_rfc3339(),
                                        "stage": stage_c,
                                        "window_index": win.window_index,
                                        "provider": provider.as_str(),
                                        "model": model_c,
                                        "input_tokens": usage.input_tokens,
                                        "output_tokens": usage.output_tokens,
                                        "cached_input_tokens": usage.cached_input_tokens,
                                    }),
                                );
                            }
                            let t_first = win.sample_times.first().copied().unwrap_or(0.0);
                            let t_last = win.sample_times.last().copied().unwrap_or(0.0);
                            {
                                let mut records = res_c.lock().unwrap();
                                records.insert(win.window_index, rec);
                                if let Some(plan) = &checkpoint_c { plan.emit(&records, &tx_c); }
                            }
                            let stage_cost = {
                                let mut u = usage_c.lock().unwrap();
                                u.add(&usage);
                                compute_cost(&model_c, &u)
                            };
                            let cum_usd = base_cost_offset_usd + stage_cost.usd;
                            let cum_twd = cum_usd * USD_TO_TWD;
                            let done_now = {
                                let mut d = done_c.lock().unwrap();
                                *d += 1;
                                *d
                            };
                            let _ = tx_c.send(BackendEvent::VisionProgress {
                                job_index,
                                done: done_now,
                                total: total_targets,
                                cost_usd: cum_usd,
                                cost_twd: cum_twd,
                            });
                            let _ = tx_c.send(BackendEvent::Log(format!(
                                "[{stage_c}] {done_now}/{total_targets} 完成 | 批次 #{:03} ({t_first:.1}s-{t_last:.1}s) 擷取 {ev_count} 筆事件 | 累計 ${cum_usd:.4} (NT${cum_twd:.1})",
                                win.window_index
                            )));
                        }
                        Err(e) => {
                            *err_c.lock().unwrap() = Some(e);
                            cancel_c.store(true, Ordering::Relaxed);
                            break;
                        }
                    },
                    Err(e) => {
                        let safe = redact_secrets(e.message(), &[&api_key_c]);
                        let mut g = err_c.lock().unwrap();
                        if g.is_none() {
                            *g = Some(safe);
                        }
                        cancel_c.store(true, Ordering::Relaxed);
                        break;
                    }
                }
            }
        }));
    }

    let stream_res = stream_missing_windows(
        video,
        &missing,
        clip_start,
        clip_end,
        track_fps,
        frame_width,
        JPEG_QUALITY,
        cancel,
        |win, jpegs| {
            let mut pending = (win.clone(), jpegs);
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err("辨識已取消。".to_string());
                }
                match job_tx.try_send(pending) {
                    Ok(()) => return Ok(()),
                    Err(mpsc::TrySendError::Full(job)) => {
                        pending = job;
                        thread::sleep(std::time::Duration::from_millis(20));
                    }
                    Err(mpsc::TrySendError::Disconnected(_)) => {
                        return Err("背景辨識執行緒已提前終止。".to_string());
                    }
                }
            }
        },
    );
    drop(job_tx);
    for h in handles {
        let _ = h.join();
    }

    if let Some(err) = shared_err.lock().unwrap().take() {
        return Err(err);
    }
    stream_res?;
    if cancel.load(Ordering::Relaxed) {
        return Err("任務已中止（已完成視窗快取已保存）。".to_string());
    }

    let out_map = Arc::try_unwrap(shared_results)
        .unwrap()
        .into_inner()
        .unwrap();
    let out_usage = Arc::try_unwrap(shared_usage).unwrap().into_inner().unwrap();
    Ok((out_map, out_usage))
}

#[allow(clippy::too_many_arguments)]
fn proofread_source_cues(
    cues: &[SubtitleCue],
    lang_code: &str,
    track_tag: &str,
    provider: Provider,
    model: &str,
    api_key: &str,
    output_dir: &Path,
    cancel: &Arc<AtomicBool>,
    tx: &Sender<BackendEvent>,
) -> Result<(Vec<SubtitleCue>, TokenUsage), String> {
    if cues.is_empty() {
        return Ok((Vec::new(), TokenUsage::default()));
    }
    let cache_dir = output_dir.join("cache").join("src_proofread");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("建立校對快取失敗：{e}"))?;

    let mut freq: BTreeMap<String, usize> = BTreeMap::new();
    for c in cues {
        for line in c
            .text
            .lines()
            .map(str::trim)
            .filter(|l| l.chars().count() >= 3)
        {
            *freq.entry(line.to_string()).or_insert(0) += 1;
        }
    }
    let recurring: Vec<String> = freq
        .into_iter()
        .filter(|(_, n)| *n >= 2)
        .take(50)
        .map(|(k, _)| k)
        .collect();

    let sys_prompt = build_proofread_system_prompt(lang_code);
    let mut total_usage = TokenUsage::default();
    let mut decisions: Vec<(bool, String)> = Vec::with_capacity(cues.len());

    for (b_idx, offset) in (0..cues.len()).step_by(PROOFREAD_BATCH_SIZE).enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err("字形校對已中止。".to_string());
        }
        let stop = (offset + PROOFREAD_BATCH_SIZE).min(cues.len());
        let rows: Vec<Value> = (offset..stop)
            .map(|i| {
                json!({
                    "id": i,
                    "start": cues[i].start,
                    "end": cues[i].end,
                    "duration": ((cues[i].end - cues[i].start) * 1000.0).round() / 1000.0,
                    "text": cues[i].text,
                })
            })
            .collect();
        let ctx_before: Vec<Value> = (offset.saturating_sub(3)..offset)
            .map(|i| json!({"id": i, "text": cues[i].text}))
            .collect();
        let ctx_after: Vec<Value> = (stop..(stop + 3).min(cues.len()))
            .map(|i| json!({"id": i, "text": cues[i].text}))
            .collect();

        let payload = json!({
            "language": lang_code,
            "recurring_terms": recurring,
            "context_before": ctx_before,
            "rows": rows,
            "context_after": ctx_after,
        });
        let fp = sha256_prefix20(
            &serde_json::to_string(&json!({
                "v": PROOFREAD_VERSION,
                "track": track_tag,
                "provider": provider.as_str(),
                "model": model,
                "payload": payload,
            }))
            .unwrap_or_default(),
        );
        let cache_file = cache_dir.join(format!("{track_tag}_{:04}_{fp}.json", b_idx + 1));

        let mut parsed_batch: Option<Vec<(bool, String)>> = None;
        if cache_file.is_file()
            && let Ok(raw) = fs::read_to_string(&cache_file)
            && let Ok(saved) = serde_json::from_str::<Value>(&raw)
            && let Some(arr) = saved["items"].as_array()
            && arr.len() == (stop - offset)
            && arr.iter().enumerate().all(|(k, it)| {
                it["id"].as_i64() == Some((offset + k) as i64)
                    && it["drop"].is_boolean()
                    && it["text"].is_string()
            })
        {
            if let Ok(u) = serde_json::from_value::<TokenUsage>(saved["usage"].clone()) {
                total_usage.add(&u);
            }
            parsed_batch = Some(
                arr.iter()
                    .map(|it| {
                        (
                            it["drop"].as_bool().unwrap_or(false),
                            it["text"].as_str().unwrap_or_default().to_string(),
                        )
                    })
                    .collect(),
            );
        }

        if parsed_batch.is_none() {
            let payload_str = serde_json::to_string(&payload).unwrap_or_default();
            let req = JsonRequest {
                provider,
                api_key,
                model,
                system: &sys_prompt,
                parts: vec![Part::Text(&payload_str)],
                schema: proofread_schema(),
                schema_name: "variety_src_proofread",
                max_output_tokens: 4096,
                temperature: 0.0,
                detail: "auto",
            };
            let (val, usage) = generate_json_retry(&req, cancel, 3).map_err(|e| {
                format!(
                    "原文字形校對未完成：{}",
                    redact_secrets(e.message(), &[api_key])
                )
            })?;
            if let Some(arr) = val["items"].as_array()
                && arr.len() == (stop - offset)
                && arr.iter().enumerate().all(|(k, it)| {
                    it["id"].as_i64() == Some((offset + k) as i64)
                        && it["drop"].is_boolean()
                        && it["text"].is_string()
                })
            {
                let _ = atomic_write_json(&cache_file, &json!({"items": arr, "usage": usage}));
                total_usage.add(&usage);
                parsed_batch = Some(
                    arr.iter()
                        .map(|it| {
                            (
                                it["drop"].as_bool().unwrap_or(false),
                                it["text"].as_str().unwrap_or_default().to_string(),
                            )
                        })
                        .collect(),
                );
            }
        }

        if let Some(batch_out) = parsed_batch {
            decisions.extend(batch_out);
        } else {
            return Err("原文字形校對回應缺漏或格式無效；已完成的辨識快取仍保留。".into());
        }
    }

    let mut fixed_count = 0_usize;
    let mut dropped_count = 0_usize;
    let mut out_cues: Vec<SubtitleCue> = Vec::with_capacity(cues.len());

    for (idx, (orig, (drop_flag, cand_text))) in cues.iter().zip(decisions).enumerate() {
        if drop_flag {
            let dur = orig.end - orig.start;
            let protected = ["자료제공", "Case", "Q.", "!", "?", "提供"]
                .iter()
                .any(|kw| orig.text.contains(kw));
            let is_blur_ghost = dur <= 0.65
                && ((idx > 0
                    && (orig.start - cues[idx - 1].end).abs() <= 0.30
                    && char_similarity(
                        &normalize_text(&orig.text),
                        &normalize_text(&cues[idx - 1].text),
                    ) >= 0.40)
                    || (idx + 1 < cues.len()
                        && (cues[idx + 1].start - orig.end).abs() <= 0.30
                        && char_similarity(
                            &normalize_text(&orig.text),
                            &normalize_text(&cues[idx + 1].text),
                        ) >= 0.40));
            if is_blur_ghost || !protected {
                dropped_count += 1;
                continue;
            }
        }

        let cleaned = clean_cue_text(&cand_text);
        let final_text = if !cleaned.is_empty() && cleaned != orig.text {
            let sim = char_similarity(&normalize_text(&orig.text), &normalize_text(&cleaned));
            let same_lines = orig.text.lines().count() == cleaned.lines().count();
            if sim >= 0.72 && same_lines {
                fixed_count += 1;
                cleaned
            } else {
                orig.text.clone()
            }
        } else {
            orig.text.clone()
        };

        let mut updated = orig.clone();
        updated.id = out_cues.len() + 1;
        updated.text = final_text;
        out_cues.push(updated);
    }

    let _ = tx.send(BackendEvent::Log(format!(
        "[Proofread:{track_tag}] 原文字形勘誤完成：修正 {fixed_count} 處字形誤認，過濾 {dropped_count} 段實景／殘影雜訊"
    )));
    Ok((out_cues, total_usage))
}

#[allow(clippy::too_many_arguments)]
fn build_episode_glossary(
    cues: &[SubtitleCue],
    user_glossary: &BTreeMap<String, String>,
    provider: Provider,
    model: &str,
    api_key: &str,
    output_dir: &Path,
    cancel: &Arc<AtomicBool>,
    tx: &Sender<BackendEvent>,
) -> (BTreeMap<String, String>, TokenUsage) {
    let mut merged = user_glossary.clone();
    if cues.len() < 10 {
        return (merged, TokenUsage::default());
    }

    let mut line_counts: BTreeMap<String, usize> = BTreeMap::new();
    for c in cues {
        for line in c.text.lines().map(str::trim).filter(|l| !l.is_empty()) {
            *line_counts.entry(line.to_string()).or_insert(0) += 1;
        }
    }
    let mut candidates: Vec<(usize, String)> = line_counts
        .into_iter()
        .map(|(line, cnt)| {
            let boost = if ["〈", "<", "@", "Case", "유튜브", "자료제공"]
                .iter()
                .any(|m| line.contains(m))
            {
                5
            } else {
                0
            };
            (cnt + boost, line)
        })
        .collect();
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let sample_lines: Vec<String> = candidates.into_iter().take(150).map(|(_, l)| l).collect();

    let payload = json!({
        "existing_glossary": user_glossary,
        "caption_lines": sample_lines,
    });
    let fp = sha256_prefix20(
        &serde_json::to_string(&json!({
            "v": AUTO_GLOSSARY_VERSION,
            "provider": provider.as_str(),
            "model": model,
            "payload": payload,
        }))
        .unwrap_or_default(),
    );
    let cache_dir = output_dir.join("cache").join("translate");
    let _ = fs::create_dir_all(&cache_dir);
    let cache_file = cache_dir.join(format!("auto_glossary_{fp}.json"));

    if cache_file.is_file()
        && let Ok(raw) = fs::read_to_string(&cache_file)
        && let Ok(saved) = serde_json::from_str::<Value>(&raw)
        && let Some(arr) = saved["entries"].as_array()
    {
        for it in arr {
            if let (Some(k), Some(z)) = (it["ko"].as_str(), it["zh"].as_str()) {
                let k = k.trim();
                let z = z.trim();
                if !k.is_empty() && !z.is_empty() {
                    merged.entry(k.to_string()).or_insert_with(|| z.to_string());
                }
            }
        }
        let u = serde_json::from_value::<TokenUsage>(saved["usage"].clone()).unwrap_or_default();
        return (merged, u);
    }

    let payload_str = serde_json::to_string(&payload).unwrap_or_default();
    let req = JsonRequest {
        provider,
        api_key,
        model,
        system: AUTO_GLOSSARY_SYSTEM_PROMPT,
        parts: vec![Part::Text(&payload_str)],
        schema: auto_glossary_schema(),
        schema_name: "variety_auto_glossary",
        max_output_tokens: 2048,
        temperature: 0.1,
        detail: "auto",
    };

    match generate_json_retry(&req, cancel, 2) {
        Ok((val, usage)) => {
            let mut added = 0_usize;
            if let Some(arr) = val["entries"].as_array() {
                let _ = atomic_write_json(&cache_file, &json!({"entries": arr, "usage": usage}));
                for it in arr {
                    if let (Some(k), Some(z)) = (it["ko"].as_str(), it["zh"].as_str()) {
                        let k = k.trim();
                        let z = z.trim();
                        if !k.is_empty() && !z.is_empty() && !merged.contains_key(k) {
                            merged.insert(k.to_string(), z.to_string());
                            added += 1;
                        }
                    }
                }
            }
            if let Ok(g_val) = serde_json::to_value(&merged) {
                let _ = atomic_write_json(&output_dir.join("auto_glossary.json"), &g_val);
            }
            let _ = tx.send(BackendEvent::Log(format!(
                "[Glossary] 專有名詞預掃描完成：新增 {added} 組統一譯名（總計 {} 組）",
                merged.len()
            )));
            (merged, usage)
        }
        Err(_) => (merged, TokenUsage::default()),
    }
}

fn resolve_dominant_language(cfg_lang: SourceLang, records: &[WindowVisionRecord]) -> String {
    if cfg_lang != SourceLang::Auto {
        return cfg_lang.code().to_string();
    }
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for rec in records {
        if !rec.events.is_empty() {
            let code = SourceLang::from_detected(&rec.detected_language).code();
            *counts.entry(code).or_insert(0) += rec.events.len();
        }
    }
    counts
        .into_iter()
        .max_by_key(|&(_, c)| c)
        .map(|(k, _)| k.to_string())
        .unwrap_or_else(|| "ko".to_string())
}

fn execute_single_job(
    app_dir: &Path,
    job_index: usize,
    total_jobs: usize,
    cfg: &RunConfig,
    cancel: &Arc<AtomicBool>,
    tx: &Sender<BackendEvent>,
) -> Result<f64, String> {
    let started = Instant::now();
    let (api_key_opt, key_source) = load_api_key_with_source(cfg.provider);
    let api_key = api_key_opt.ok_or_else(|| {
        format!(
            "尚未設定 {} API 金鑰（目前狀態：{}），請展開「引擎與進階設定」加密儲存金鑰。",
            cfg.provider.display_name(),
            key_source
        )
    })?;

    fs::create_dir_all(&cfg.output_dir).map_err(|e| format!("建立輸出資料夾失敗：{e}"))?;
    let video = probe_video(&cfg.video_path)?;

    let raw_start = cfg.start.unwrap_or(0.0).max(0.0);
    if raw_start >= video.duration
        || cfg
            .duration
            .is_some_and(|d| raw_start + d > video.duration + 0.001)
    {
        return Err("辨識範圍超出影片來源長度，請重新整理影片範圍。".into());
    }
    let raw_end = match cfg.duration {
        Some(d) if d > 0.0 => (raw_start + d).min(video.duration),
        _ => video.duration,
    };

    // Stage 1: Native full-framerate (up to 30 FPS) 5-zone local edge & tile tracker ($0 API cost)
    let frame_track = if cfg.smart_accuracy {
        Some(load_or_run_frame_track(
            &video,
            raw_start,
            raw_end,
            &cfg.output_dir,
            cancel,
            tx,
        )?)
    } else {
        None
    };

    let plan = build_adaptive_sample_plan(
        &video,
        raw_start,
        cfg.duration,
        cfg.fps as f64,
        WINDOW_SECONDS,
        OVERLAP_SECONDS,
        frame_track.as_ref(),
        cfg.smart_accuracy,
    )?;
    let (clip_start, clip_end, track_fps, global_pts, sample_track_indices, windows) = (
        plan.clip_start,
        plan.clip_end,
        plan.track_fps,
        plan.sample_times,
        plan.track_indices,
        plan.windows,
    );
    let clip_duration = clip_end - clip_start;

    let est = estimate_run_cost(
        clip_duration,
        cfg.provider,
        &cfg.vision_model,
        &cfg.translate_model,
        cfg.fps as f64,
        WINDOW_SECONDS,
        OVERLAP_SECONDS,
        cfg.frame_width,
        &cfg.detail,
        cfg.translate_enabled,
        cfg.smart_accuracy,
    );

    let _ = tx.send(BackendEvent::Log(format!(
        "=== 綜藝畫面字幕擷取系統 v{VERSION}［任務 {}/{}］===\n\
         影片：{} ({}x{}, {:.2} fps)\n\
         範圍：{:.1}s ~ {:.1}s（共 {:.1}s，事件抽樣 {} 幀，{} 批視窗，追蹤步進 {:.0}ms）\n\
         來源語言：{} | 引擎：{} ({}) | 選配翻譯：{}\n\
         預估費用：約 ${:.4} USD（約 NT${:.1}）",
        job_index + 1,
        total_jobs,
        video
            .path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        video.width,
        video.height,
        video.fps,
        clip_start,
        clip_end,
        clip_duration,
        global_pts.len(),
        windows.len(),
        1000.0 / track_fps,
        cfg.source_lang.label(),
        cfg.provider.display_name(),
        cfg.vision_model,
        if cfg.translate_enabled {
            cfg.translate_model.as_str()
        } else {
            "關閉（純擷取原文 SRT）"
        },
        est.total_usd,
        est.total_twd,
    )));

    // Stage 2: Event-keyframe VLM recognition & dual-track (`card` vs `dialogue`) classification
    let (fp, fp_config) =
        vision_fingerprint(&video.path, clip_start, clip_end, global_pts.len(), cfg)?;
    let cache_dir = cfg.output_dir.join("cache").join("vision").join(&fp);
    fs::create_dir_all(&cache_dir).map_err(|e| format!("建立快取目錄失敗：{e}"))?;
    atomic_write_json(&cache_dir.join("config.json"), &fp_config)?;
    let usage_log = cache_dir.join("vision_usage.jsonl");

    let vision_t0 = Instant::now();
    let empty_hints = HashMap::new();
    let (mut base_map, base_vision_usage) = run_vision_windows(
        job_index,
        &video,
        &windows,
        &empty_hints,
        clip_start,
        clip_end,
        track_fps,
        frame_track.as_ref(),
        cfg.fps as f64,
        cfg.frame_width,
        cfg.source_lang,
        cfg.provider,
        &cfg.vision_model,
        &cfg.detail,
        cfg.workers,
        &api_key,
        &cache_dir,
        &usage_log,
        "Vision",
        0.0,
        cancel,
        tx,
    )?;

    let mut ordered_records: Vec<WindowVisionRecord> = windows
        .iter()
        .filter_map(|w| base_map.remove(&w.window_index))
        .collect();
    let base_vision_cost = compute_cost(&cfg.vision_model, &base_vision_usage);
    let mut escalated_usage = TokenUsage::default();
    let mut escalated_cost_usd = 0.0;

    // Stage 2b: Automatic Two-Pass Flagship Escalation (1440px high-detail) on hard windows
    let flagship_model = flagship_model_for(cfg.provider);
    if cfg.smart_accuracy
        && needs_high_resolution_review(&cfg.vision_model, flagship_model, cfg.frame_width)
        && !ordered_records.is_empty()
    {
        let hard = find_hard_windows(&ordered_records);
        if !hard.is_empty() {
            let mut hard_specs = Vec::with_capacity(hard.len());
            let mut hints_map = HashMap::new();
            let mut reason_summary = Vec::new();
            for (w_idx, hint, reason) in &hard {
                if let Some(spec) = windows.get(*w_idx) {
                    hard_specs.push(spec.clone());
                    if let Some(h) = hint {
                        hints_map.insert(*w_idx, h.clone());
                    }
                    reason_summary.push(format!("#{w_idx:02}({reason})"));
                }
            }
            let _ = tx.send(BackendEvent::Log(format!(
                "[Escalate] 啟動高解析複檢：共 {} 個疑難批次 → {} @ {}px [{}]",
                hard_specs.len(),
                flagship_model,
                ESCALATE_FRAME_WIDTH,
                reason_summary.join(", ")
            )));

            // Older reviews could be biased by the conflicting transcription as a hint.
            // Keep the initial scan cache, but regenerate reviews under the new policy.
            let esc_cache_dir = cache_dir.join(format!(
                "escalated_{flagship_model}_{ESCALATE_FRAME_WIDTH}_{ESCALATE_REVIEW_POLICY}"
            ));
            let (mut esc_map, esc_u) = run_vision_windows(
                job_index,
                &video,
                &hard_specs,
                &hints_map,
                clip_start,
                clip_end,
                track_fps,
                frame_track.as_ref(),
                cfg.fps as f64,
                ESCALATE_FRAME_WIDTH,
                cfg.source_lang,
                cfg.provider,
                flagship_model,
                "high",
                cfg.workers.min(4),
                &api_key,
                &esc_cache_dir,
                &usage_log,
                "Escalate",
                base_vision_cost.usd,
                cancel,
                tx,
            )?;
            escalated_cost_usd = compute_cost(flagship_model, &esc_u).usd;
            escalated_usage = esc_u;

            for rec in &mut ordered_records {
                if let Some(upgraded) = esc_map.remove(&rec.window_index) {
                    *rec = upgraded;
                }
            }
        }
    }

    let lang_code = resolve_dominant_language(cfg.source_lang, &ordered_records);

    // Stage 3: Multi-slot overlapping stitch + ±1-frame boundary snapping + clean progressive consolidation
    let (mut card_cues, mut dialogue_cues) = stitch_dual_tracks(
        &ordered_records,
        &global_pts,
        clip_start,
        clip_end,
        cfg.fps as f64,
        1,
        Some(&sample_track_indices),
        frame_track.as_ref(),
    );

    // Stage 3b: Multi-language post-OCR proofreader
    let mut proof_usage = TokenUsage::default();
    let mut proof_cost_usd = 0.0;
    if cfg.smart_accuracy {
        if !card_cues.is_empty() {
            let (refined, u1) = proofread_source_cues(
                &card_cues,
                &lang_code,
                "cards",
                cfg.provider,
                flagship_model,
                &api_key,
                &cfg.output_dir,
                cancel,
                tx,
            )?;
            proof_usage.add(&u1);
            card_cues = refined;
        }
        if !dialogue_cues.is_empty() {
            let (refined, u2) = proofread_source_cues(
                &dialogue_cues,
                &lang_code,
                "dialogue",
                cfg.provider,
                flagship_model,
                &api_key,
                &cfg.output_dir,
                cancel,
                tx,
            )?;
            proof_usage.add(&u2);
            dialogue_cues = refined;
        }
        proof_cost_usd = compute_cost(flagship_model, &proof_usage).usd;
    }

    let mut final_cues = card_cues.clone();
    final_cues.extend(dialogue_cues.clone());
    final_cues.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.end.total_cmp(&b.end)));
    final_cues = clamp_cues(final_cues, clip_start, clip_end);
    if cancel.load(Ordering::Relaxed) {
        return Err("辨識已取消，已完成視窗快取已保存。".into());
    }
    let _ = tx.send(BackendEvent::Result {
        cues: final_cues,
        processed_end: clip_end,
    });

    let stem = video
        .path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "video".to_string());
    let cards_srt_path = cfg.output_dir.join(format!("{stem}.cards.{lang_code}.srt"));
    let dialogue_srt_path = cfg
        .output_dir
        .join(format!("{stem}.dialogue.{lang_code}.srt"));

    atomic_write_json(
        &cfg.output_dir.join("cards.source.json"),
        &serde_json::to_value(&card_cues).unwrap_or_default(),
    )?;
    if !card_cues.is_empty() {
        write_srt(&cards_srt_path, &card_cues)?;
        let _ = tx.send(BackendEvent::Log(format!(
            "[Output] 綜藝字卡原文 SRT 已寫出：{}（共 {} 段）",
            cards_srt_path.display(),
            card_cues.len()
        )));
    }
    if !dialogue_cues.is_empty() {
        atomic_write_json(
            &cfg.output_dir.join("dialogue.source.json"),
            &serde_json::to_value(&dialogue_cues).unwrap_or_default(),
        )?;
        write_srt(&dialogue_srt_path, &dialogue_cues)?;
        let _ = tx.send(BackendEvent::Log(format!(
            "[Output] 底部對白硬字幕 SRT 已獨立寫出：{}（共 {} 段）",
            dialogue_srt_path.display(),
            dialogue_cues.len()
        )));
    } else if dialogue_srt_path.is_file() {
        let _ = fs::remove_file(&dialogue_srt_path);
    }

    let _ = tx.send(BackendEvent::TracksReady {
        output_dir: cfg.output_dir.clone(),
    });

    let mut eval_ko_val = Value::Null;
    let ref_dir = if cfg.auto_eval {
        find_eval_ref_dir(app_dir, &video.path)
    } else {
        None
    };
    if let Some(ref rd) = ref_dir
        && !card_cues.is_empty()
    {
        let ref_ko = rd.join("cards.ko.srt");
        if ref_ko.is_file() && lang_code == "ko" {
            let m = evaluate_srt(
                &cards_srt_path,
                &ref_ko,
                Some(&cfg.output_dir.join("eval_ko_report.md")),
                Some(&cfg.output_dir.join("eval_ko_metrics.json")),
            )?;
            let summary_line = format!(
                "字元準確 {:.1}% · 同步 {:.1}%",
                m["char_accuracy"].as_f64().unwrap_or(0.0) * 100.0,
                m["timeline_aligned_text_similarity"]
                    .as_f64()
                    .unwrap_or(0.0)
                    * 100.0,
            );
            let _ = tx.send(BackendEvent::EvalSummary {
                summary: summary_line.clone(),
            });
            let _ = tx.send(BackendEvent::Log(format!(
                "[Eval] {summary_line} | 涵蓋相似度 {:.1}% | 時間軸 F1 {:.1}%",
                m["avg_cue_similarity"].as_f64().unwrap_or(0.0) * 100.0,
                m["timeline_presence_f1"].as_f64().unwrap_or(0.0) * 100.0,
            )));
            eval_ko_val = m;
        }
    }

    // Optional Stage 4: Taiwanese Traditional Chinese translation (off by default per user workflow!)
    let mut trans_usage = TokenUsage::default();
    let mut trans_cost_usd = 0.0;
    let mut zh_cards_out: Option<PathBuf> = None;
    let mut zh_dialogue_out: Option<PathBuf> = None;

    if cfg.translate_enabled && (!card_cues.is_empty() || !dialogue_cues.is_empty()) {
        let user_glossary: BTreeMap<String, String> = if cfg.glossary_path.is_file() {
            let raw = fs::read_to_string(&cfg.glossary_path).unwrap_or_else(|_| "{}".to_string());
            let clean = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
            serde_json::from_str(clean).unwrap_or_default()
        } else {
            BTreeMap::new()
        };

        let (effective_glossary, g_usage) = if cfg.smart_accuracy {
            build_episode_glossary(
                &card_cues,
                &user_glossary,
                cfg.provider,
                &cfg.translate_model,
                &api_key,
                &cfg.output_dir,
                cancel,
                tx,
            )
        } else {
            (user_glossary, TokenUsage::default())
        };
        trans_usage.add(&g_usage);

        if !card_cues.is_empty() {
            let (zh_c, u_c) = translate_cards(
                job_index,
                &card_cues,
                "cards",
                cfg.provider,
                &cfg.translate_model,
                &api_key,
                &cfg.output_dir,
                &effective_glossary,
                cancel,
                tx,
            )?;
            trans_usage.add(&u_c);
            let p = cfg.output_dir.join(format!("{stem}.cards.zh-Hant.srt"));
            write_srt(&p, &zh_c)?;
            zh_cards_out = Some(p);
        }

        if !dialogue_cues.is_empty() {
            let (zh_d, u_d) = translate_cards(
                job_index,
                &dialogue_cues,
                "dialogue",
                cfg.provider,
                &cfg.translate_model,
                &api_key,
                &cfg.output_dir,
                &effective_glossary,
                cancel,
                tx,
            )?;
            trans_usage.add(&u_d);
            let p = cfg.output_dir.join(format!("{stem}.dialogue.zh-Hant.srt"));
            write_srt(&p, &zh_d)?;
            zh_dialogue_out = Some(p);
        }

        trans_cost_usd = compute_cost(&cfg.translate_model, &trans_usage).usd;
        let _ = tx.send(BackendEvent::TracksReady {
            output_dir: cfg.output_dir.clone(),
        });
    }

    let vision_total_usd = base_vision_cost.usd + escalated_cost_usd + proof_cost_usd;
    let total_usd = ((vision_total_usd + trans_cost_usd) * 100_000.0).round() / 100_000.0;
    let total_twd = (total_usd * USD_TO_TWD * 100.0).round() / 100.0;
    let elapsed = (started.elapsed().as_secs_f64() * 100.0).round() / 100.0;

    let summary = json!({
        "version": VERSION,
        "status": "complete",
        "video": video.path.display().to_string(),
        "detected_language": lang_code,
        "track_fps": track_fps,
        "provider": cfg.provider.as_str(),
        "vision_model": cfg.vision_model,
        "smart_accuracy": cfg.smart_accuracy,
        "translate_enabled": cfg.translate_enabled,
        "cards_cue_count": card_cues.len(),
        "dialogue_cue_count": dialogue_cues.len(),
        "outputs": {
            "cards_srt": if card_cues.is_empty() { None } else { Some(cards_srt_path.display().to_string()) },
            "dialogue_srt": if dialogue_cues.is_empty() { None } else { Some(dialogue_srt_path.display().to_string()) },
            "zh_cards_srt": zh_cards_out.as_ref().map(|p| p.display().to_string()),
            "zh_dialogue_srt": zh_dialogue_out.as_ref().map(|p| p.display().to_string()),
        },
        "vision_stats": {
            "elapsed_seconds": (vision_t0.elapsed().as_secs_f64() * 100.0).round() / 100.0,
            "base_usage": base_vision_usage,
            "escalated_usage": escalated_usage,
            "proofread_usage": proof_usage,
            "estimated_cost_usd": (vision_total_usd * 100_000.0).round() / 100_000.0,
        },
        "translate_usage": trans_usage,
        "eval_ko": eval_ko_val,
        "total_estimated_cost": {
            "usd": total_usd,
            "twd": total_twd,
        },
        "elapsed_seconds": elapsed,
    });
    atomic_write_json(&cfg.output_dir.join("run_summary.json"), &summary)?;

    let _ = tx.send(BackendEvent::Log(format!(
        "=== 影片處理完成！耗時 {elapsed:.1}s | 字卡 {} 段・對白 {} 段 | 費用 ${total_usd:.4} USD（約 NT${total_twd:.1}）===",
        card_cues.len(),
        dialogue_cues.len()
    )));
    Ok(total_usd)
}

#[allow(clippy::too_many_arguments)]
fn translate_cards(
    job_index: usize,
    cues: &[SubtitleCue],
    track_tag: &str,
    provider: Provider,
    model: &str,
    api_key: &str,
    output_dir: &Path,
    glossary: &BTreeMap<String, String>,
    cancel: &Arc<AtomicBool>,
    tx: &Sender<BackendEvent>,
) -> Result<(Vec<SubtitleCue>, TokenUsage), String> {
    let trans_dir = output_dir.join("cache").join("translate").join(track_tag);
    let (mut result, mut usage) = translate_batches(
        job_index, cues, provider, model, api_key, &trans_dir, glossary, false, None, cancel, tx,
    )?;

    let mut repair_units: Vec<SubtitleCue> = Vec::new();
    let mut repair_meta: Vec<(String, usize)> = Vec::new();
    let mut spans: Vec<(usize, usize, usize)> = Vec::new();
    for (idx, (src, dst)) in cues.iter().zip(result.iter()).enumerate() {
        let src_lines: Vec<&str> = src
            .text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        let dst_lines: Vec<&str> = dst
            .text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        if src_lines.len() >= 2 && dst_lines.len() < src_lines.len() {
            let begin = repair_units.len();
            for (li, line) in src_lines.iter().enumerate() {
                repair_units.push(SubtitleCue {
                    id: repair_units.len() + 1,
                    start: src.start,
                    end: src.end,
                    text: (*line).to_string(),
                    kind: src.kind,
                    slot: src.slot.clone(),
                    source_text: None,
                    sample_start: None,
                    sample_end: None,
                });
                repair_meta.push((src.text.clone(), li));
            }
            spans.push((idx, begin, repair_units.len()));
        }
    }

    if !repair_units.is_empty() {
        let (repaired, u2) = translate_batches(
            job_index,
            &repair_units,
            provider,
            model,
            api_key,
            &trans_dir,
            glossary,
            true,
            Some(&repair_meta),
            cancel,
            tx,
        )?;
        usage.add(&u2);
        for (idx, begin, end) in spans {
            let joined = repaired[begin..end]
                .iter()
                .map(|c| c.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            result[idx].text = clean_cue_text(&joined);
        }
    }

    Ok((result, usage))
}

#[allow(clippy::too_many_arguments)]
fn translate_batches(
    job_index: usize,
    cues: &[SubtitleCue],
    provider: Provider,
    model: &str,
    api_key: &str,
    trans_dir: &Path,
    glossary: &BTreeMap<String, String>,
    repair_mode: bool,
    repair_meta: Option<&[(String, usize)]>,
    cancel: &Arc<AtomicBool>,
    tx: &Sender<BackendEvent>,
) -> Result<(Vec<SubtitleCue>, TokenUsage), String> {
    let cache_dir = trans_dir.join(if repair_mode {
        "line_repair_cache"
    } else {
        "batch_cache"
    });
    fs::create_dir_all(&cache_dir).map_err(|e| format!("建立翻譯快取目錄失敗：{e}"))?;
    let usage_log = trans_dir.join("translate_usage.jsonl");

    let system_prompt = if repair_mode {
        format!("{TRANSLATE_SYSTEM_PROMPT}{LINE_REPAIR_SUFFIX}")
    } else {
        TRANSLATE_SYSTEM_PROMPT.to_string()
    };
    let prompt_tag = if repair_mode {
        format!("{TRANSLATE_PROMPT_VERSION}:line_repair")
    } else {
        TRANSLATE_PROMPT_VERSION.to_string()
    };

    let total_batches = cues.len().div_ceil(TRANSLATE_BATCH_SIZE) as u32;
    let mut translated: Vec<SubtitleCue> = Vec::with_capacity(cues.len());
    let mut totals = TokenUsage::default();

    for (b_idx, offset) in (0..cues.len()).step_by(TRANSLATE_BATCH_SIZE).enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err("翻譯已由使用者中止。".to_string());
        }
        let batch_num = (b_idx + 1) as u32;
        let stop = (offset + TRANSLATE_BATCH_SIZE).min(cues.len());
        let batch = &cues[offset..stop];
        let expected_ids: Vec<i64> = (offset..stop).map(|i| i as i64).collect();

        let prev_ctx: Vec<Value> = (offset.saturating_sub(4)..offset)
            .map(|i| json!({"id": i, "text": cues[i].text}))
            .collect();
        let next_ctx: Vec<Value> = (stop..(stop + 4).min(cues.len()))
            .map(|i| json!({"id": i, "text": cues[i].text}))
            .collect();
        let prev_trans: Vec<Value> = (offset.saturating_sub(8)..offset)
            .map(|i| json!({"id": i, "source": cues[i].text, "zh": translated[i].text}))
            .collect();

        let rows: Vec<Value> = (offset..stop)
            .map(|i| {
                let mut obj = json!({
                    "id": i,
                    "start": cues[i].start,
                    "end": cues[i].end,
                    "text": cues[i].text,
                });
                if let Some(meta) = repair_meta {
                    obj["card_context"] = json!(meta[i].0);
                    obj["line_index"] = json!(meta[i].1);
                }
                obj
            })
            .collect();

        let payload = json!({
            "glossary": glossary,
            "context_before": prev_ctx,
            "previous_translations": prev_trans,
            "rows": rows,
            "context_after": next_ctx,
        });
        let fp_input = json!({
            "prompt": prompt_tag,
            "provider": provider.as_str(),
            "model": model,
            "payload": payload,
        });
        let fp = sha256_prefix20(&serde_json::to_string(&fp_input).unwrap_or_default());
        let cache_file = cache_dir.join(format!("batch_{batch_num:04}_{fp}.json"));

        let mut items: Option<Vec<String>> = None;
        if cache_file.is_file()
            && let Ok(raw) = fs::read_to_string(&cache_file)
            && let Ok(saved) = serde_json::from_str::<Value>(&raw)
            && saved["fingerprint"].as_str() == Some(fp.as_str())
            && let Ok(valid) = validate_translation_items(&saved, &expected_ids)
        {
            if let Ok(u) = serde_json::from_value::<TokenUsage>(saved["usage"].clone()) {
                totals.add(&u);
            }
            items = Some(valid);
        }

        if items.is_none() {
            let payload_str = serde_json::to_string(&payload).unwrap_or_default();
            let mut last_err = String::new();
            for _attempt in 1..=3 {
                let req = JsonRequest {
                    provider,
                    api_key,
                    model,
                    system: &system_prompt,
                    parts: vec![Part::Text(&payload_str)],
                    schema: translate_schema(),
                    schema_name: "variety_card_translations",
                    max_output_tokens: 4096,
                    temperature: 0.2,
                    detail: "auto",
                };
                match generate_json_retry(&req, cancel, 3) {
                    Ok((val, usage)) => match validate_translation_items(&val, &expected_ids) {
                        Ok(valid) => {
                            let to_save: Vec<Value> = expected_ids
                                .iter()
                                .zip(valid.iter())
                                .map(|(&id, t)| json!({"id": id, "text": t}))
                                .collect();
                            let _ = atomic_write_json(
                                &cache_file,
                                &json!({
                                    "fingerprint": fp,
                                    "provider": provider.as_str(),
                                    "model": model,
                                    "translations": to_save,
                                    "usage": usage,
                                }),
                            );
                            append_jsonl(
                                &usage_log,
                                &json!({
                                    "utc": Utc::now().to_rfc3339(),
                                    "batch": batch_num,
                                    "provider": provider.as_str(),
                                    "model": model,
                                    "input_tokens": usage.input_tokens,
                                    "output_tokens": usage.output_tokens,
                                }),
                            );
                            totals.add(&usage);
                            items = Some(valid);
                            break;
                        }
                        Err(e) => last_err = e,
                    },
                    Err(e) => {
                        return Err(redact_secrets(e.message(), &[api_key]));
                    }
                }
            }
            if items.is_none() {
                return Err(format!("第 {batch_num} 批翻譯驗證失敗：{last_err}"));
            }
        }

        for (cue, text) in batch.iter().zip(items.unwrap()) {
            translated.push(SubtitleCue {
                id: cue.id,
                start: cue.start,
                end: cue.end,
                text,
                kind: cue.kind,
                slot: cue.slot.clone(),
                source_text: Some(cue.text.clone()),
                sample_start: cue.sample_start,
                sample_end: cue.sample_end,
            });
        }

        if !repair_mode {
            let _ = tx.send(BackendEvent::TranslateProgress {
                job_index,
                done: batch_num,
                total: total_batches,
            });
        }
    }

    Ok((translated, totals))
}

fn validate_translation_items(val: &Value, expected_ids: &[i64]) -> Result<Vec<String>, String> {
    let arr = val["translations"]
        .as_array()
        .ok_or_else(|| "翻譯回傳缺少 translations 陣列。".to_string())?;
    if arr.len() != expected_ids.len() {
        return Err(format!(
            "翻譯筆數不符（預期 {}，收到 {}）。",
            expected_ids.len(),
            arr.len()
        ));
    }
    let mut out = Vec::with_capacity(arr.len());
    for (item, &exp_id) in arr.iter().zip(expected_ids.iter()) {
        if item["id"].as_i64() != Some(exp_id) {
            return Err("翻譯 id 順序或編號與來源不一致。".to_string());
        }
        let text = clean_cue_text(item["text"].as_str().unwrap_or_default());
        if text.is_empty() {
            return Err(format!("第 {exp_id} 筆翻譯為空白。"));
        }
        out.push(text);
    }
    Ok(out)
}

pub fn open_in_explorer(path: &Path) {
    let mut cmd = Command::new("explorer");
    cmd.arg(path);
    let _ = cmd.spawn();
}

pub fn open_file_default(path: &Path) {
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "start", "", &path.to_string_lossy()]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let _ = cmd.spawn();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::srt::CaptionKind;
    use crate::stitcher::RawCardEvent;

    fn record(index: usize, start: usize, end: usize) -> WindowVisionRecord {
        WindowVisionRecord {
            window_index: index,
            global_start: start,
            global_end: end,
            actual_times: (start..=end).map(|i| i as f64 * 0.5).collect(),
            detected_language: "en".into(),
            provider: "openai".into(),
            model: "gpt-4.1-mini".into(),
            usage: TokenUsage::default(),
            elapsed_seconds: 0.0,
            events: vec![RawCardEvent {
                start_frame: 0,
                end_frame: end - start,
                slot: "bottom".into(),
                kind: CaptionKind::Card,
                text: format!("Card {index}"),
            }],
        }
    }

    #[test]
    fn every_flagged_window_is_reviewed_in_short_and_long_clips() {
        for count in [10, 200] {
            let records: Vec<_> = (0..count)
                .map(|index| {
                    let mut item = record(index, index * 20, index * 20 + 15);
                    item.events[0].text = format!("@source_{index}");
                    item
                })
                .collect();
            let hard = find_hard_windows(&records);
            assert_eq!(
                hard.iter().map(|item| item.0).collect::<Vec<_>>(),
                (0..count).collect::<Vec<_>>(),
                "all known difficult windows need review regardless of clip length"
            );
        }
    }

    #[test]
    fn flagship_initial_scan_still_needs_review_below_1440_pixels() {
        assert!(needs_high_resolution_review("gpt-5.4", "gpt-5.4", 1280));
        assert!(needs_high_resolution_review(
            "gpt-5.4-mini",
            "gpt-5.4",
            1440
        ));
        assert!(!needs_high_resolution_review("gpt-5.4", "gpt-5.4", 1440));
    }

    #[test]
    fn contradictory_overlap_reviews_both_windows_without_a_text_hint() {
        let mut first = record(0, 0, 15);
        first.events[0].start_frame = 13;
        first.events[0].text = "짐싸라비좀".into();
        let mut second = record(1, 13, 28);
        second.events[0].end_frame = 2;
        second.events[0].text = "캐리어 하나로 떠나는 주문\n짐쌀라비움".into();
        let hard = find_hard_windows(&[first.clone(), second.clone()]);
        assert_eq!(
            hard.iter().map(|item| item.0).collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert!(hard.iter().all(|item| item.1.is_none()));

        first.events[0].text = second.events[0].text.clone();
        assert!(find_hard_windows(&[first, second]).is_empty());
    }

    #[test]
    fn checkpoints_never_cross_an_unfinished_window() {
        let windows: Vec<_> = [(0, 0, 15), (1, 13, 28), (2, 26, 39)]
            .into_iter()
            .map(|(index, start, end)| WindowSpec {
                window_index: index,
                global_start: start,
                global_end: end,
                track_indices: (start..=end).map(|i| i * 15).collect(),
                sample_times: (start..=end).map(|i| i as f64 * 0.5).collect(),
            })
            .collect();
        let plan = CheckpointPlan::new(&windows, 0.0, 20.0, 2.0, None);
        let mut records = BTreeMap::new();
        records.insert(2, record(2, 26, 39));
        assert!(plan.snapshot(&records).is_none());
        records.insert(0, record(0, 0, 15));
        let (cues, end) = plan.snapshot(&records).unwrap();
        assert_eq!(end, 6.5);
        assert!(cues.iter().all(|c| c.end <= end && c.text != "Card 2"));
        records.insert(1, record(1, 13, 28));
        let (cues, end) = plan.snapshot(&records).unwrap();
        assert_eq!(end, 20.0);
        assert!(cues.iter().all(|c| c.start >= 0.0 && c.end <= end));
        assert!(cues.iter().any(|c| c.text == "Card 2"));
    }

    #[test]
    fn obsolete_review_cache_is_rejected_and_current_review_cache_is_reusable() {
        const CHILD_ROOT: &str = "SUBTOOL_REVIEW_CACHE_TEST_ROOT";
        const TEST_NAME: &str = "pipeline::tests::obsolete_review_cache_is_rejected_and_current_review_cache_is_reusable";

        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            let root = PathBuf::from(root);
            let diagnostic = root.join("child-failure.txt");
            std::panic::set_hook(Box::new(move |error| {
                let _ = fs::write(&diagnostic, error.to_string());
            }));
            exercise_review_cache(&root);
            return;
        }

        // Tool and credential OnceLocks belong to a worker process. Keep this
        // integration test isolated from the other native tests using them.
        let root = std::env::temp_dir().join(format!(
            "subtool-review-cache-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        struct OwnedTemp(PathBuf);
        impl Drop for OwnedTemp {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = OwnedTemp(root.clone());
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args(["--exact", TEST_NAME])
            .env(CHILD_ROOT, &root)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        child.creation_flags(CREATE_NO_WINDOW);
        let status = child.status().unwrap();
        assert!(
            status.success(),
            "isolated cache regression failed: {}",
            fs::read_to_string(root.join("child-failure.txt"))
                .unwrap_or_else(|_| format!("child status: {status}"))
        );
        assert!(root.join("verified.json").is_file());
    }

    fn exercise_review_cache(root: &Path) {
        let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ffmpeg");
        let tools = if cfg!(target_os = "macos") {
            tools.join("darwin-arm64")
        } else {
            tools
        };
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let ffmpeg = tools.join(format!("ffmpeg{suffix}"));
        let ffprobe = tools.join(format!("ffprobe{suffix}"));
        assert!(ffmpeg.is_file() && ffprobe.is_file());
        crate::video::configure_tools(ffmpeg.clone(), ffprobe).unwrap();
        crate::credentials::set_api_key("offline-review-cache-test-no-network".into()).unwrap();

        let source = root.join("one-second.mkv");
        let mut generate = Command::new(ffmpeg);
        generate
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=black:size=320x180:rate=30:duration=1",
                "-an",
                "-c:v",
                "ffv1",
            ])
            .arg(&source)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        generate.creation_flags(CREATE_NO_WINDOW);
        assert!(generate.status().unwrap().success());

        let output = root.join("output");
        let cfg = RunConfig {
            video_path: source.clone(),
            output_dir: output.clone(),
            glossary_path: output.join("unused.json"),
            source_lang: SourceLang::Auto,
            provider: Provider::OpenAI,
            vision_model: "gpt-5.4-mini".into(),
            translate_model: "unused".into(),
            fps: 2.0,
            frame_width: 320,
            detail: "high".into(),
            workers: 1,
            translate_enabled: false,
            smart_accuracy: true,
            start: Some(0.0),
            duration: Some(1.0),
            auto_eval: false,
        };
        let video = probe_video(&source).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, _rx) = mpsc::channel();
        let track = load_or_run_frame_track(&video, 0.0, 1.0, &output, &cancel, &tx).unwrap();
        let plan = build_adaptive_sample_plan(
            &video,
            0.0,
            Some(1.0),
            2.0,
            WINDOW_SECONDS,
            OVERLAP_SECONDS,
            Some(&track),
            true,
        )
        .unwrap();
        assert!(!plan.windows.is_empty());
        let (fingerprint, config) =
            vision_fingerprint(&source, 0.0, 1.0, plan.sample_times.len(), &cfg).unwrap();
        let cache = output.join("cache/vision").join(fingerprint);
        atomic_write_json(&cache.join("config.json"), &config).unwrap();
        let flagship = flagship_model_for(cfg.provider);
        let obsolete = cache.join(format!("escalated_{flagship}_{ESCALATE_FRAME_WIDTH}"));
        let current = cache.join(format!(
            "escalated_{flagship}_{ESCALATE_FRAME_WIDTH}_{ESCALATE_REVIEW_POLICY}"
        ));
        let mut review_records = Vec::new();
        for window in &plan.windows {
            let mut base = record(window.window_index, window.global_start, window.global_end);
            base.actual_times = window.sample_times.clone();
            base.model = cfg.vision_model.clone();
            base.events[0].text = "자료제공".into();
            assert_eq!(find_hard_windows(&[base.clone()]).len(), 1);
            let file = format!("win_{:05}.json", window.window_index);
            atomic_write_json(&cache.join(&file), &serde_json::to_value(&base).unwrap()).unwrap();
            let mut reviewed = base;
            reviewed.model = flagship.into();
            // A review can reject a false positive. If the obsolete directory
            // is used, these empty events would finish without proofreading.
            reviewed.events.clear();
            let value = serde_json::to_value(reviewed).unwrap();
            atomic_write_json(&obsolete.join(&file), &value).unwrap();
            review_records.push((file, value));
        }

        let (tx, rx) = mpsc::channel();
        let error = execute_single_job(root, 0, 1, &cfg, &Arc::new(AtomicBool::new(false)), &tx)
            .expect_err("obsolete reviews must not satisfy the new review policy");
        assert!(error.contains("測試禁止網路請求"), "{error}");
        assert!(
            !rx.try_iter()
                .any(|event| matches!(event, BackendEvent::Result { .. }))
        );

        for (file, value) in review_records {
            atomic_write_json(&current.join(file), &value).unwrap();
        }
        for _ in 0..2 {
            let (tx, rx) = mpsc::channel();
            execute_single_job(root, 0, 1, &cfg, &Arc::new(AtomicBool::new(false)), &tx)
                .expect("matching current reviews must complete without any HTTP request");
            let results: Vec<_> = rx
                .try_iter()
                .filter_map(|event| match event {
                    BackendEvent::Result {
                        cues,
                        processed_end,
                    } => Some((cues, processed_end)),
                    _ => None,
                })
                .collect();
            assert_eq!(results.len(), 1);
            assert!(results[0].0.is_empty());
            assert_eq!(results[0].1, 1.0);
            let cues: Value =
                serde_json::from_slice(&fs::read(output.join("cards.source.json")).unwrap())
                    .unwrap();
            assert_eq!(cues, json!([]));
        }
        let (_, final_config) =
            vision_fingerprint(&source, 0.0, 1.0, plan.sample_times.len(), &cfg).unwrap();
        assert_eq!(
            config, final_config,
            "source evidence and settings must remain unchanged"
        );
        atomic_write_json(
            &root.join("verified.json"),
            &json!({
                "obsolete_review_rejected":true, "current_review_replays":2,
                "network":"forbidden_by_test_build", "source_config":final_config,
            }),
        )
        .unwrap();
    }

    /// Optional acceptance against user-owned v3 reference data. All HTTP is forbidden in test builds.
    /// Set SUBTOOL_CARD_VISION_FIXTURE to a completed v3 output directory and SUBTOOL_CARD_VISION_VIDEO
    /// to the original source, then run cargo test --locked offline_v3_fixture -- --ignored --nocapture.
    #[test]
    #[ignore = "requires original video and completed v3 reference cache; never calls the network"]
    fn offline_v3_fixture() {
        let fixture = PathBuf::from(
            std::env::var_os("SUBTOOL_CARD_VISION_FIXTURE").expect("fixture directory"),
        );
        let source =
            PathBuf::from(std::env::var_os("SUBTOOL_CARD_VISION_VIDEO").expect("source video"));
        let original_vision = fs::read_dir(fixture.join("cache/vision"))
            .unwrap()
            .map(Result::unwrap)
            .map(|e| e.path())
            .find(|p| p.join("config.json").is_file())
            .expect("vision cache");
        let original_config: Value =
            serde_json::from_slice(&fs::read(original_vision.join("config.json")).unwrap())
                .unwrap();
        assert_eq!(original_config["engine_version"], "3.0.0");
        assert_eq!(original_config["prompt_version"], VISION_PROMPT_VERSION);
        assert_eq!(original_config["provider"], "openai");
        let metadata = fs::metadata(&source).unwrap();
        assert_eq!(
            Some(metadata.len()),
            original_config["video_size"].as_u64(),
            "source size must match reference"
        );
        let modified = metadata
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            .to_string();
        assert_eq!(
            Some(modified.as_str()),
            original_config["video_mtime_ns"].as_str(),
            "source modification time must match reference"
        );
        let output = std::env::temp_dir().join(format!(
            "subtool-card-vision-offline-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&output).unwrap();
        let native = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ffmpeg");
        let native = if cfg!(target_os = "macos") {
            native.join("darwin-arm64")
        } else {
            native
        };
        let ext = if cfg!(windows) { ".exe" } else { "" };
        crate::video::configure_tools(
            native.join(format!("ffmpeg{ext}")),
            native.join(format!("ffprobe{ext}")),
        )
        .unwrap();
        crate::credentials::set_api_key("offline-test-no-network".into()).unwrap();
        let start = original_config["clip_start"].as_f64().unwrap();
        let end = original_config["clip_end"].as_f64().unwrap();
        let cfg = RunConfig {
            video_path: source.clone(),
            output_dir: output.clone(),
            glossary_path: output.join("unused.json"),
            source_lang: SourceLang::Auto,
            provider: Provider::OpenAI,
            vision_model: original_config["model"].as_str().unwrap().into(),
            translate_model: "unused".into(),
            fps: original_config["sample_fps"].as_f64().unwrap() as f32,
            frame_width: original_config["frame_width"].as_u64().unwrap() as u32,
            detail: original_config["detail"].as_str().unwrap().into(),
            workers: 2,
            translate_enabled: false,
            smart_accuracy: true,
            start: Some(start),
            duration: Some(end - start),
            auto_eval: false,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel();
        let video = probe_video(&source).unwrap();
        // Recompute every local tracking frame; do not trust the old source path or tracking cache.
        let track = load_or_run_frame_track(&video, start, end, &output, &cancel, &tx).unwrap();
        let plan = build_adaptive_sample_plan(
            &video,
            start,
            Some(end - start),
            cfg.fps as f64,
            WINDOW_SECONDS,
            OVERLAP_SECONDS,
            Some(&track),
            true,
        )
        .unwrap();
        assert_eq!(
            Some(plan.sample_times.len() as u64),
            original_config["sample_count"].as_u64()
        );
        for window in &plan.windows {
            let record: WindowVisionRecord = serde_json::from_slice(
                &fs::read(original_vision.join(format!("win_{:05}.json", window.window_index)))
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(record.provider, cfg.provider.as_str());
            assert_eq!(record.model, cfg.vision_model);
            assert_eq!(record.global_start, window.global_start);
            assert_eq!(record.global_end, window.global_end);
            assert_eq!(
                record.actual_times, window.sample_times,
                "native keyframe sampling changed"
            );
        }
        fn copy_tree(source: &Path, destination: &Path) {
            fs::create_dir_all(destination).unwrap();
            for entry in fs::read_dir(source).unwrap().map(Result::unwrap) {
                let target = destination.join(entry.file_name());
                if entry.file_type().unwrap().is_dir() {
                    copy_tree(&entry.path(), &target);
                } else {
                    fs::copy(entry.path(), target).unwrap();
                }
            }
        }
        // Import only into this isolated test directory, after metadata and all frame labels match.
        let (key, _) =
            vision_fingerprint(&source, start, end, plan.sample_times.len(), &cfg).unwrap();
        copy_tree(&original_vision, &output.join("cache/vision").join(key));
        copy_tree(
            &fixture.join("cache/src_proofread"),
            &output.join("cache/src_proofread"),
        );
        execute_single_job(&output, 0, 1, &cfg, &cancel, &tx)
            .expect("offline replay must satisfy every VLM and proofreading request from cache");
        let actual: Value =
            serde_json::from_slice(&fs::read(output.join("cards.source.json")).unwrap()).unwrap();
        let expected: Value =
            serde_json::from_slice(&fs::read(fixture.join("cards.source.json")).unwrap()).unwrap();
        assert_eq!(
            actual, expected,
            "complete replay must reproduce reference cues including exact boundaries"
        );
        let srt = output.join(format!(
            "{}.cards.ko.srt",
            source.file_stem().unwrap().to_string_lossy()
        ));
        let parsed = crate::srt::parse_srt_file(&srt).unwrap();
        assert_eq!(parsed.len(), actual.as_array().unwrap().len());
        assert!(parsed.iter().any(|c| c.text == "어질"));
        assert!(
            parsed
                .iter()
                .any(|c| c.text.contains("아우터 1장") && c.text.contains("속옷"))
        );
        let final_events: Vec<_> = rx
            .try_iter()
            .filter_map(|e| match e {
                BackendEvent::Result { cues, .. } => Some(cues),
                _ => None,
            })
            .collect();
        assert_eq!(final_events.len(), 1);
        for time in [80.0, 84.5, 124.0] {
            crate::video::extract_preview_jpeg(&source, time, &output.join("previews")).unwrap();
        }
        let report = json!({"mode":"offline_reference_cache_replay","network":"forbidden_by_test_build","source_size":metadata.len(),"source_mtime_ns":modified,"sample_times_exact":true,"sample_count":plan.sample_times.len(),"window_count":plan.windows.len(),"cue_count":parsed.len(),"source_cues_exact":true,"srt":srt,"output":output});
        atomic_write_json(&output.join("offline-verification.json"), &report).unwrap();
        println!("{report}");
    }
}

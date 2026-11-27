//! Headless adapter for the kvariety-card-vision core. One stdin request owns one process.
#[allow(dead_code)]
mod credentials;
#[allow(dead_code)]
mod eval;
#[allow(dead_code)]
mod llm;
#[allow(dead_code)]
mod pipeline;
#[allow(dead_code)]
mod pricing;
#[allow(dead_code)]
mod srt;
mod stitcher;
#[allow(dead_code)]
mod video;

use credentials::{Provider, redact_secrets};
use pipeline::{BackendEvent, RunConfig};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::UNIX_EPOCH;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    path: PathBuf,
    start: f64,
    end: f64,
    samples_per_second: f32,
    source_lang: String,
    provider: Provider,
    model: String,
    smart_accuracy: bool,
    frame_width: u32,
    api_key: String,
    cache_dir: PathBuf,
    ffmpeg_path: PathBuf,
    ffprobe_path: PathBuf,
}

fn emit(value: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn identity_path(root: &Path, identity: &Value) -> PathBuf {
    root.join(format!(
        "{:x}",
        Sha256::digest(identity.to_string().as_bytes())
    ))
}

fn cache_identity_path(root: &Path, identity: &Value) -> PathBuf {
    let exact = identity_path(root, identity);
    if exact.is_dir() {
        return exact;
    }
    let Some(start) = identity["start"].as_f64() else {
        return exact;
    };
    let Some(end) = identity["end"].as_f64() else {
        return exact;
    };
    let adjacent = |mut value: f64, steps: i32| {
        for _ in 0..steps.abs() {
            value = if steps < 0 {
                value.next_down()
            } else {
                value.next_up()
            };
        }
        value
    };
    // Older serde_json parsing could shift an Electron boundary by a few ULPs.
    // Probe only complete identities differing in those clock bits; never copy or relax source/settings evidence.
    let offsets = [0_i32, -1, 1, -2, 2, -3, 3, -4, 4];
    for distance in 1..=4 {
        for &start_offset in &offsets {
            for &end_offset in &offsets {
                if start_offset.abs().max(end_offset.abs()) != distance {
                    continue;
                }
                let first = adjacent(start, start_offset);
                let last = adjacent(end, end_offset);
                if !first.is_finite() || !last.is_finite() || first < 0.0 || last <= first {
                    continue;
                }
                let mut compatible = identity.clone();
                compatible["start"] = json!(first);
                compatible["end"] = json!(last);
                let candidate = identity_path(root, &compatible);
                if candidate.is_dir() {
                    return candidate;
                }
            }
        }
    }
    exact
}

fn execute(req: Request) -> Result<(), String> {
    if !req.path.is_absolute()
        || !req.path.is_file()
        || !req.cache_dir.is_absolute()
        || !req.ffmpeg_path.is_absolute()
        || !req.ffmpeg_path.is_file()
        || !req.ffprobe_path.is_absolute()
        || !req.ffprobe_path.is_file()
    {
        return Err("影片、快取與影音工具必須使用有效的完整路徑。".into());
    }
    if !req.start.is_finite()
        || !req.end.is_finite()
        || req.start < 0.0
        || req.end <= req.start
        || !(0.1..=10.0).contains(&req.samples_per_second)
        || !(320..=1920).contains(&req.frame_width)
    {
        return Err("辨識範圍、取樣率或影像寬度無效。".into());
    }
    if req.api_key.trim().is_empty()
        || req.api_key.len() > 4096
        || req.api_key.contains(['\r', '\n'])
    {
        return Err("請設定有效的雲端辨識 API 金鑰。".into());
    }
    if req.model.is_empty()
        || req.model.len() > 128
        || !req
            .model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._:".contains(c))
    {
        return Err("模型名稱無效。".into());
    }
    let lang = match req.source_lang.as_str() {
        "auto" => srt::SourceLang::Auto,
        "ko" => srt::SourceLang::Korean,
        "ja" => srt::SourceLang::Japanese,
        "zh" => srt::SourceLang::Chinese,
        "en" => srt::SourceLang::English,
        _ => return Err("辨識語言無效。".into()),
    };
    let metadata = std::fs::metadata(&req.path).map_err(|_| "無法讀取影片。")?;
    let source_path = req.path.clone();
    let source_modified = metadata.modified().map_err(|_| "無法讀取影片修改時間。")?;
    let source_size = metadata.len();
    let verify_source = || -> Result<(), String> {
        let current =
            std::fs::metadata(&source_path).map_err(|_| "辨識期間影片來源已無法讀取。")?;
        if current.len() != source_size || current.modified().ok() != Some(source_modified) {
            return Err("辨識期間影片來源已變更，請重新辨識。".into());
        }
        Ok(())
    };
    let identity = json!({
        "version": "subtool-card-vision-1", "path": std::fs::canonicalize(&req.path).map_err(|_| "無法解析影片路徑。")?,
        "size": metadata.len(), "modified": metadata.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|t| t.as_nanos().to_string()),
        "start": req.start, "end": req.end, "fps": req.samples_per_second,
        "language": req.source_lang, "provider": req.provider.as_str(), "model": req.model,
        "smartAccuracy": req.smart_accuracy, "frameWidth": req.frame_width,
    });
    let output = cache_identity_path(&req.cache_dir, &identity);
    credentials::set_api_key(req.api_key)?;
    video::configure_tools(req.ffmpeg_path, req.ffprobe_path)?;
    let cfg = RunConfig {
        video_path: req.path,
        output_dir: output.clone(),
        glossary_path: output.join("unused-glossary.json"),
        source_lang: lang,
        provider: req.provider,
        vision_model: req.model.clone(),
        translate_model: req.model,
        fps: req.samples_per_second,
        frame_width: req.frame_width,
        detail: "high".into(),
        workers: 2,
        translate_enabled: false,
        smart_accuracy: req.smart_accuracy,
        start: Some(req.start),
        duration: Some(req.end - req.start),
        auto_eval: false,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let stdin_cancel = Arc::clone(&cancel);
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if serde_json::from_str::<Value>(&line)
                .ok()
                .is_some_and(|v| v["type"] == "cancel")
            {
                stdin_cancel.store(true, Ordering::Relaxed);
                break;
            }
        }
    });
    emit(json!({"type":"progress", "progress":0.0, "message":"正在分析畫面與規劃辨識視窗"}));
    let rx = pipeline::spawn_batch_pipeline(output, vec![cfg], Arc::clone(&cancel));
    let mut final_result = None;
    let mut failure = None;
    let mut progress = 0.0_f64;
    for event in rx {
        match event {
            BackendEvent::Checkpoint {
                cues,
                processed_end,
            } => {
                if let Err(error) = verify_source() {
                    failure = Some(error);
                    cancel.store(true, Ordering::Relaxed);
                    continue;
                }
                emit(json!({"type":"checkpoint", "cues":cues, "processedEnd":processed_end}));
            }
            BackendEvent::Result {
                cues,
                processed_end,
            } => {
                if let Err(error) = verify_source() {
                    failure = Some(error);
                    cancel.store(true, Ordering::Relaxed);
                    continue;
                }
                if (processed_end - req.end).abs() > 0.001 {
                    return Err("辨識範圍超出可讀取的影片長度。".into());
                }
                final_result = Some(json!({"type":"result", "cues":cues, "processedEnd":req.end}));
            }
            BackendEvent::VisionProgress { done, total, .. } => {
                progress = progress.max(0.05 + 0.80 * f64::from(done) / f64::from(total.max(1)));
                emit(
                    json!({"type":"progress", "progress":progress, "message":format!("畫面辨識 {done}／{total}")}),
                );
            }
            BackendEvent::Log(message) => {
                let safe = redact_secrets(&message, &[]);
                if safe.starts_with("[Error]") {
                    failure = Some(safe.trim_start_matches("[Error] ").to_string());
                    continue;
                }
                let label = if safe.starts_with("[Proofread") {
                    progress = progress.max(0.90);
                    "正在校對原文字形"
                } else if safe.starts_with("[Escalate]") {
                    "正在複檢複雜字卡"
                } else if safe.starts_with("[Track]") {
                    "正在追蹤畫面變化與字幕邊界"
                } else if safe.starts_with("[Output]") {
                    "正在整理辨識結果"
                } else {
                    continue;
                };
                emit(json!({"type":"progress", "progress":progress, "message":label}));
            }
            BackendEvent::BatchFinished { completed, .. } => {
                if completed == 1
                    && let Some(result) = final_result
                {
                    verify_source()?;
                    emit(result);
                    return Ok(());
                }
                return Err(failure.unwrap_or_else(|| {
                    if cancel.load(Ordering::Relaxed) {
                        "辨識已取消，已完成視窗快取已保留。".into()
                    } else {
                        "畫面文字辨識未完成。".into()
                    }
                }));
            }
            _ => {}
        }
    }
    Err("辨識引擎提前結束。".into())
}

fn main() {
    let result = (|| {
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(|_| "無法讀取辨識請求。".to_string())?;
        let request: Request =
            serde_json::from_str(&line).map_err(|_| "辨識請求格式無效。".to_string())?;
        execute(request)
    })();
    if let Err(error) = result {
        emit(json!({"type":"error", "message":redact_secrets(&error, &[])}));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_end_survives_ndjson_roundtrip() {
        // Use independently recorded bits: a rounded Rust literal would make this regression circular.
        let request: Request = serde_json::from_str(
            r#"{
            "path":"source.mp4","start":10.477133333333333,"end":47.047000000000004,
            "samplesPerSecond":2,"sourceLang":"auto","provider":"openai","model":"gpt-5.4-mini",
            "smartAccuracy":true,"frameWidth":1280,"apiKey":"test-only","cacheDir":"cache",
            "ffmpegPath":"ffmpeg","ffprobePath":"ffprobe"
        }"#,
        )
        .unwrap();
        // Independently measured IEEE-754 bits from Electron: 1410 / (30000 / 1001).
        assert_eq!(request.end.to_bits(), 4631818093924152509);
        let response = json!({"processedEnd":request.end}).to_string();
        assert_eq!(response, r#"{"processedEnd":47.047000000000004}"#);
    }

    #[test]
    fn legacy_clock_cache_reuse_preserves_every_other_identity_field() {
        let root = std::env::temp_dir().join(format!(
            "subtool-clock-cache-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let end = f64::from_bits(4631818093924152509);
        let identity = json!({"version":"subtool-card-vision-1","path":"source.mp4","size":123,"modified":"456","start":10.0,"end":end,"fps":2.0,"language":"auto","provider":"openai","model":"gpt-5.4-mini","smartAccuracy":true,"frameWidth":1280});
        let mut legacy = identity.clone();
        legacy["end"] = json!(end.next_down());
        let old = identity_path(&root, &legacy);
        std::fs::create_dir(&old).unwrap();
        assert_eq!(cache_identity_path(&root, &identity), old);
        for (key, value) in [
            ("path", json!("other.mp4")),
            ("size", json!(124)),
            ("modified", json!("457")),
            ("model", json!("gpt-5.4")),
            ("provider", json!("gemini")),
            ("fps", json!(3.0)),
            ("frameWidth", json!(1440)),
            ("smartAccuracy", json!(false)),
        ] {
            let mut changed = identity.clone();
            changed[key] = value;
            assert_eq!(
                cache_identity_path(&root, &changed),
                identity_path(&root, &changed),
                "changed {key} must not reuse another job"
            );
        }
        let mut distant = identity.clone();
        distant["end"] = json!(f64::from_bits(end.to_bits() + 4)); // Five ULPs from the only existing legacy folder.
        assert_eq!(
            cache_identity_path(&root, &distant),
            identity_path(&root, &distant)
        );
        let exact = identity_path(&root, &identity);
        std::fs::create_dir(&exact).unwrap();
        assert_eq!(
            cache_identity_path(&root, &identity),
            exact,
            "exact identity wins over a nearby legacy cache"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

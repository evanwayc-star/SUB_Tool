//! SubRip (.srt) parser, UTF-8 BOM writer (supporting overlapping cues), and dual-track (`cards` / `dialogue`) management.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceLang {
    Auto,
    Korean,
    Japanese,
    Chinese,
    English,
}

impl SourceLang {
    pub fn label(self) -> &'static str {
        match self {
            SourceLang::Auto => "自動",
            SourceLang::Korean => "韓文",
            SourceLang::Japanese => "日文",
            SourceLang::Chinese => "中文",
            SourceLang::English => "英文",
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            SourceLang::Auto => "auto",
            SourceLang::Korean => "ko",
            SourceLang::Japanese => "ja",
            SourceLang::Chinese => "zh",
            SourceLang::English => "en",
        }
    }

    pub fn from_detected(code: &str) -> Self {
        match code.trim().to_lowercase().as_str() {
            "ko" | "kor" | "korean" => SourceLang::Korean,
            "ja" | "jp" | "jpn" | "japanese" => SourceLang::Japanese,
            "zh" | "zh-hant" | "zh-hans" | "zh-tw" | "zh-cn" | "chinese" => SourceLang::Chinese,
            "en" | "eng" | "english" => SourceLang::English,
            _ => SourceLang::Korean,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionKind {
    #[default]
    Card,
    Dialogue,
}

impl CaptionKind {
    pub fn label(self) -> &'static str {
        match self {
            CaptionKind::Card => "綜藝字卡",
            CaptionKind::Dialogue => "對白字幕",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SubtitleCue {
    pub id: usize,
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default)]
    pub kind: CaptionKind,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub slot: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_start: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_end: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct SrtCue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct EditableCue {
    pub index: usize,
    pub start: f64,
    pub end: f64,
    pub timecode: String,
    pub text: String,
    pub zh_text: String,
    pub kind: CaptionKind,
    pub overlaps: bool,
}

#[derive(Clone, Debug, Default)]
pub struct LoadedTracks {
    pub cards: Vec<EditableCue>,
    pub dialogue: Vec<EditableCue>,
    pub cards_path: Option<PathBuf>,
    pub dialogue_path: Option<PathBuf>,
    pub zh_cards_path: Option<PathBuf>,
    pub zh_dialogue_path: Option<PathBuf>,
    pub lang_tag: String,
}

pub fn format_timestamp(seconds: f64) -> String {
    let total_ms = (seconds.max(0.0) * 1000.0).round() as u64;
    let hours = total_ms / 3_600_000;
    let rem = total_ms % 3_600_000;
    let minutes = rem / 60_000;
    let rem = rem % 60_000;
    let secs = rem / 1_000;
    let ms = rem % 1_000;
    format!("{hours:02}:{minutes:02}:{secs:02},{ms:03}")
}

/// Parse either `HH:MM:SS,mmm` (`HH:MM:SS.mmm`, `MM:SS.mmm`) or plain seconds (`84.250`).
pub fn parse_flexible_timestamp(input: &str) -> Option<f64> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(sec) = s.parse::<f64>()
        && sec.is_finite()
        && sec >= 0.0
    {
        return Some((sec * 1000.0).round() / 1000.0);
    }
    if let Some(tc) = parse_tc_part(s) {
        return Some((tc * 1000.0).round() / 1000.0);
    }
    let normalized = s.replace(',', ".");
    let cols: Vec<&str> = normalized.split(':').collect();
    if cols.len() == 2 {
        let m: f64 = cols[0].trim().parse().ok()?;
        let sec: f64 = cols[1].trim().parse().ok()?;
        return Some(((m * 60.0 + sec) * 1000.0).round() / 1000.0);
    }
    None
}

pub fn clean_cue_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Atomically write cues (sorted chronologically; overlapping cues preserved!) as UTF-8 BOM + CRLF .srt.
pub fn write_srt(path: &Path, cues: &[SubtitleCue]) -> Result<usize, String> {
    let mut ordered: Vec<&SubtitleCue> = cues.iter().collect();
    ordered.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                a.end
                    .partial_cmp(&b.end)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let mut blocks = Vec::with_capacity(ordered.len());
    for (idx, cue) in ordered.iter().enumerate() {
        let mut text = clean_cue_text(&cue.text);
        if text.is_empty() {
            continue;
        }
        if !cue.start.is_finite() || !cue.end.is_finite() || cue.start < 0.0 {
            return Err(format!(
                "第 {} 筆字幕時間碼無效：{} -> {}",
                idx + 1,
                cue.start,
                cue.end
            ));
        }
        let end = if (cue.end * 1000.0).round() <= (cue.start * 1000.0).round() {
            cue.start + 0.034
        } else {
            cue.end
        };
        if text.contains("-->") {
            text = text.replace("-->", "->");
        }
        blocks.push(format!(
            "{}\r\n{} --> {}\r\n{}\r\n",
            blocks.len() + 1,
            format_timestamp(cue.start),
            format_timestamp(end),
            text.replace('\n', "\r\n")
        ));
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("建立輸出目錄失敗：{e}"))?;
    }
    let tmp = path.with_extension(format!("srt.{}.tmp", std::process::id()));
    let mut bytes = vec![0xEF, 0xBB, 0xBF]; // UTF-8 BOM
    bytes.extend_from_slice(blocks.join("\r\n").as_bytes());
    fs::write(&tmp, &bytes).map_err(|e| format!("寫入暫存 SRT 失敗：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("覆寫 SRT 失敗：{e}")
    })?;
    Ok(blocks.len())
}

fn parse_tc_part(s: &str) -> Option<f64> {
    let trimmed = s.trim();
    let (hms, ms_str) = trimmed
        .split_once(',')
        .or_else(|| trimmed.split_once('.'))?;
    let mut parts = hms.split(':');
    let h: f64 = parts.next()?.trim().parse().ok()?;
    let m: f64 = parts.next()?.trim().parse().ok()?;
    let sec: f64 = parts.next()?.trim().parse().ok()?;
    let ms_digits: String = ms_str.trim().chars().take(3).collect();
    let ms_padded = format!("{ms_digits:0<3}");
    let ms: f64 = ms_padded.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec + ms / 1000.0)
}

fn parse_timecode_line(line: &str) -> Option<(f64, f64)> {
    let (left, right) = line.trim().split_once("-->")?;
    let r_token = right.split_whitespace().next()?;
    Some((parse_tc_part(left)?, parse_tc_part(r_token)?))
}

/// Strictly parses an SRT file anchored on timecode lines so numeric subtitle lines never break blocks.
pub fn parse_srt_file(path: &Path) -> Result<Vec<SrtCue>, String> {
    let raw =
        fs::read_to_string(path).map_err(|e| format!("無法讀取 {}: {}", path.display(), e))?;
    let stripped = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    let lines: Vec<&str> = stripped.lines().collect();

    let mut tc_entries = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if let Some((start, end)) = parse_timecode_line(line) {
            tc_entries.push((i, start, end));
        }
    }

    let mut cues = Vec::with_capacity(tc_entries.len());
    for (pos, &(tc_line, start, end)) in tc_entries.iter().enumerate() {
        let next_tc = if pos + 1 < tc_entries.len() {
            tc_entries[pos + 1].0
        } else {
            lines.len()
        };

        let mut body_end = next_tc;
        if pos + 1 < tc_entries.len() {
            let mut k = next_tc;
            while k > tc_line + 1 && lines[k - 1].trim().is_empty() {
                k -= 1;
            }
            if k > tc_line + 1 && lines[k - 1].trim().chars().all(|c| c.is_ascii_digit()) {
                body_end = k - 1;
            }
        }

        let body_lines: Vec<&str> = lines[tc_line + 1..body_end]
            .iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();

        if !body_lines.is_empty() {
            cues.push(SrtCue {
                start: (start * 1000.0).round() / 1000.0,
                end: (end * 1000.0).round() / 1000.0,
                text: body_lines.join("\n"),
            });
        }
    }
    Ok(cues)
}

fn mark_overlaps(cues: &mut [EditableCue]) {
    for i in 0..cues.len() {
        let mut ov = false;
        for (j, other) in cues.iter().enumerate() {
            if i != j && cues[i].start < other.end - 0.005 && other.start < cues[i].end - 0.005 {
                ov = true;
                break;
            }
        }
        cues[i].overlaps = ov;
        cues[i].index = i + 1;
        cues[i].timecode = format!(
            "{} --> {}",
            format_timestamp(cues[i].start),
            format_timestamp(cues[i].end)
        );
    }
}

pub fn refresh_editable_indices_and_overlaps(cues: &mut [EditableCue]) {
    cues.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                a.end
                    .partial_cmp(&b.end)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    mark_overlaps(cues);
}

fn pair_track(
    src_path: Option<&Path>,
    zh_path: Option<&Path>,
    kind: CaptionKind,
) -> Vec<EditableCue> {
    let src = src_path
        .filter(|p| p.is_file())
        .and_then(|p| parse_srt_file(p).ok())
        .unwrap_or_default();
    let zh = zh_path
        .filter(|p| p.is_file())
        .and_then(|p| parse_srt_file(p).ok())
        .unwrap_or_default();

    let count = src.len().max(zh.len());
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let sc = src.get(i);
        let zc = zh.get(i);
        let start = sc
            .map(|c| c.start)
            .or_else(|| zc.map(|c| c.start))
            .unwrap_or(0.0);
        let end = sc
            .map(|c| c.end)
            .or_else(|| zc.map(|c| c.end))
            .unwrap_or(start + 0.5);
        out.push(EditableCue {
            index: i + 1,
            start,
            end,
            timecode: format!("{} --> {}", format_timestamp(start), format_timestamp(end)),
            text: sc.map(|c| c.text.clone()).unwrap_or_default(),
            zh_text: zc.map(|c| c.text.clone()).unwrap_or_default(),
            kind,
            overlaps: false,
        });
    }
    mark_overlaps(&mut out);
    out
}

/// Discover and load `.cards*.srt` and `.dialogue*.srt` (plus optional `.zh-Hant.srt`) from an output folder.
pub fn load_tracks_from_dir(dir: &Path) -> LoadedTracks {
    let mut out = LoadedTracks::default();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };

    for entry in entries.flatten() {
        let p = entry.path();
        let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if !name.ends_with(".srt") {
            continue;
        }
        if name.contains(".cards.") || name.starts_with("cards.") {
            if name.ends_with(".zh-Hant.srt") {
                out.zh_cards_path = Some(p);
            } else {
                for tag in ["ko", "ja", "zh", "en"] {
                    if name.ends_with(&format!(".{tag}.srt")) {
                        out.lang_tag = tag.to_string();
                    }
                }
                out.cards_path = Some(p);
            }
        } else if name.contains(".dialogue.") || name.starts_with("dialogue.") {
            if name.ends_with(".zh-Hant.srt") {
                out.zh_dialogue_path = Some(p);
            } else {
                out.dialogue_path = Some(p);
            }
        }
    }

    out.cards = pair_track(
        out.cards_path.as_deref(),
        out.zh_cards_path.as_deref(),
        CaptionKind::Card,
    );
    out.dialogue = pair_track(
        out.dialogue_path.as_deref(),
        out.zh_dialogue_path.as_deref(),
        CaptionKind::Dialogue,
    );
    out
}

fn write_editable_slice(
    cues: &[EditableCue],
    src_path: Option<&Path>,
    zh_path: Option<&Path>,
) -> Result<(), String> {
    if let Some(p) = src_path {
        let list: Vec<SubtitleCue> = cues
            .iter()
            .filter(|c| !clean_cue_text(&c.text).is_empty())
            .enumerate()
            .map(|(i, c)| SubtitleCue {
                id: i + 1,
                start: c.start,
                end: c.end,
                text: clean_cue_text(&c.text),
                kind: c.kind,
                slot: String::new(),
                source_text: None,
                sample_start: None,
                sample_end: None,
            })
            .collect();
        if !list.is_empty() {
            write_srt(p, &list)?;
        } else if p.is_file() {
            let _ = fs::remove_file(p);
        }
    }
    if let Some(p) = zh_path {
        let list: Vec<SubtitleCue> = cues
            .iter()
            .filter(|c| !clean_cue_text(&c.zh_text).is_empty())
            .enumerate()
            .map(|(i, c)| SubtitleCue {
                id: i + 1,
                start: c.start,
                end: c.end,
                text: clean_cue_text(&c.zh_text),
                kind: c.kind,
                slot: String::new(),
                source_text: None,
                sample_start: None,
                sample_end: None,
            })
            .collect();
        if !list.is_empty() {
            write_srt(p, &list)?;
        }
    }
    Ok(())
}

/// Persist both `cards` and `dialogue` tracks back to disk (creating `.dialogue.srt` if user moved cues there).
pub fn save_loaded_tracks(tracks: &mut LoadedTracks, fallback_dir: &Path) -> Result<(), String> {
    refresh_editable_indices_and_overlaps(&mut tracks.cards);
    refresh_editable_indices_and_overlaps(&mut tracks.dialogue);

    if tracks.cards_path.is_none() && !tracks.cards.is_empty() {
        tracks.cards_path = Some(fallback_dir.join("extracted.cards.srt"));
    }
    if tracks.dialogue_path.is_none() && !tracks.dialogue.is_empty() {
        let dlg_path = if let Some(ref cp) = tracks.cards_path {
            let s = cp.to_string_lossy().replace(".cards.", ".dialogue.");
            if s != cp.to_string_lossy() {
                PathBuf::from(s)
            } else {
                fallback_dir.join("extracted.dialogue.srt")
            }
        } else {
            fallback_dir.join("extracted.dialogue.srt")
        };
        tracks.dialogue_path = Some(dlg_path);
    }

    write_editable_slice(
        &tracks.cards,
        tracks.cards_path.as_deref(),
        tracks.zh_cards_path.as_deref(),
    )?;
    write_editable_slice(
        &tracks.dialogue,
        tracks.dialogue_path.as_deref(),
        tracks.zh_dialogue_path.as_deref(),
    )?;
    Ok(())
}

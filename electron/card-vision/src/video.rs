//! Full-framerate (up to 30 FPS native) 5-zone local frame tracker, ±1-frame boundary snapper,
//! event-driven keyframe planner, preview frame extractor, and Lanczos+unsharp JPEG streamer.

use image::codecs::jpeg::JpegEncoder;
use image::{ColorType, ImageEncoder as _};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const HEADER_HEIGHT: u32 = 28;
const SCAN_W: usize = 320;
const SCAN_H: usize = 180;
const TILE_COLS: usize = 8;
const TILE_ROWS: usize = 6;
pub const NUM_TILES: usize = TILE_COLS * TILE_ROWS;
pub const NUM_ZONES: usize = 5; // 0:Bottom, 1:Center, 2:TopLeft, 3:TopRight, 4:Floating

#[derive(Clone, Debug)]
pub struct VideoInfo {
    pub path: PathBuf,
    pub duration: f64,
    pub fps: f64,
    pub width: u32,
    pub height: u32,
    pub stream_index: u64,
    pub region: Option<Region>,
    pub timestamp_offset: f64,
}

/// Normalized coordinates in the rotated, square-pixel display.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Region {
    pub fn valid(&self) -> bool {
        self.x >= 0.0
            && self.y >= 0.0
            && self.width > 0.0
            && self.height > 0.0
            && self.x + self.width <= 1.0
            && self.y + self.height <= 1.0
    }
}

impl VideoInfo {
    // FPS-SYNC: an off-grid seek can fall inside a held VFR frame. Keep the decoded
    // GOP preroll and sample the image already visible at each requested source time.
    fn grid_filter(&self, source_start: f64, track_fps: f64) -> String {
        let origin_us = ((source_start - self.timestamp_offset) * 1_000_000.0).round() as i64;
        format!("settb=AVTB,setpts=PTS-({origin_us}),fps={track_fps:.9}:start_time=0:round=up")
    }

    fn filters(&self) -> String {
        self.region.map(|r| format!(
            "crop=w='max(2,iw*{:.12})':h='max(2,ih*{:.12})':x=iw*{:.12}:y=ih*{:.12}:exact=1,",
            r.width, r.height, r.x, r.y
        )).unwrap_or_default()
    }

    pub fn extraction_size(&self, max_width: u32) -> Result<(u32, u32), String> {
        let (w, h) = self
            .region
            .map(|r| {
                (
                    (self.width as f64 * r.width).round() as u32,
                    (self.height as f64 * r.height).round() as u32,
                )
            })
            .unwrap_or((self.width, self.height));
        extraction_dimensions(w, h, max_width)
    }
}

static TOOLS: OnceLock<(PathBuf, PathBuf)> = OnceLock::new();

pub fn configure_tools(ffmpeg: PathBuf, ffprobe: PathBuf) -> Result<(), String> {
    TOOLS
        .set((ffmpeg, ffprobe))
        .map_err(|_| "影音工具已設定。".to_string())
}

/// Full-framerate per-zone visual transition & tile-profile tracker (`±1 frame` = `±33ms` precision).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FrameTrack {
    pub track_fps: f64,
    pub clip_start: f64,
    pub clip_end: f64,
    pub global_scores: Vec<f32>,
    pub zone_scores: Vec<[f32; NUM_ZONES]>,
    /// Flattened `num_frames * 48` tile edge-density bytes for instant spatial comparison & compact JSON.
    pub flat_tiles: Vec<u8>,
    pub median_global: f32,
    pub zone_medians: [f32; NUM_ZONES],
    pub global_threshold: f32,
}

impl FrameTrack {
    pub fn frame_count(&self) -> usize {
        self.global_scores.len()
    }

    pub fn matches_source(&self, start: f64, end: f64, fps: f64) -> bool {
        let count = self.frame_count();
        let expected = ((end - start) * fps).ceil() as usize;
        count > 0
            && self.track_fps == fps
            && self.clip_start == start
            && self.clip_end == end
            && count.abs_diff(expected) <= 1
            && self.zone_scores.len() == count
            && count.checked_mul(NUM_TILES) == Some(self.flat_tiles.len())
            && self.global_scores.iter().all(|score| score.is_finite())
            && self
                .zone_scores
                .iter()
                .flatten()
                .all(|score| score.is_finite())
    }

    pub fn tile_slice(&self, frame_idx: usize) -> &[u8] {
        let start = frame_idx * NUM_TILES;
        let end = (start + NUM_TILES).min(self.flat_tiles.len());
        if start < end {
            &self.flat_tiles[start..end]
        } else {
            &[]
        }
    }

    pub fn frame_time(&self, frame_idx: usize) -> f64 {
        (self.clip_start + frame_idx as f64 / self.track_fps).min(self.clip_end)
    }
}

#[derive(Clone, Debug)]
pub struct WindowSpec {
    pub window_index: usize,
    pub global_start: usize,
    pub global_end: usize,
    pub track_indices: Vec<usize>,
    pub sample_times: Vec<f64>,
}

#[derive(Clone, Debug)]
pub struct SamplePlan {
    pub clip_start: f64,
    pub clip_end: f64,
    pub track_fps: f64,
    pub sample_times: Vec<f64>,
    pub track_indices: Vec<usize>,
    pub windows: Vec<WindowSpec>,
}

/// Resolve an external tool (`ffmpeg` / `ffprobe`): check next to our .exe first, then PATH.
pub fn find_tool(name: &str) -> PathBuf {
    if let Some((ffmpeg, ffprobe)) = TOOLS.get() {
        return if name == "ffprobe" {
            ffprobe.clone()
        } else {
            ffmpeg.clone()
        };
    }
    let exe_name = format!("{name}.exe");
    if let Ok(cur) = std::env::current_exe()
        && let Some(dir) = cur.parent()
    {
        let local = dir.join(&exe_name);
        if local.is_file() {
            return local;
        }
    }
    PathBuf::from(name)
}

fn new_tool_cmd(name: &str) -> Command {
    let mut cmd = Command::new(find_tool(name));
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn drain_stderr(child: &mut Child) -> std::thread::JoinHandle<Vec<u8>> {
    let stderr = child.stderr.take();
    std::thread::spawn(move || {
        let mut retained = Vec::new();
        if let Some(mut stream) = stderr {
            let mut bytes = [0_u8; 4096];
            while let Ok(count) = stream.read(&mut bytes) {
                if count == 0 {
                    break;
                }
                let room = 8192_usize.saturating_sub(retained.len());
                retained.extend_from_slice(&bytes[..count.min(room)]);
            }
        }
        retained
    })
}

pub fn probe_video(video_path: &Path) -> Result<VideoInfo, String> {
    if !video_path.is_file() {
        return Err(format!("找不到影片檔案：{}", video_path.display()));
    }
    let out = new_tool_cmd("ffprobe")
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            &video_path.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("無法執行 ffprobe（請確認系統已安裝 FFmpeg）：{e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe 讀取影片失敗：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let val: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("解析 ffprobe 輸出失敗：{e}"))?;
    let streams = val["streams"]
        .as_array()
        .ok_or_else(|| "找不到視訊串流。".to_string())?;
    let v_stream = streams
        .iter()
        .find(|s| {
            s["codec_type"].as_str() == Some("video")
                && s["disposition"]["attached_pic"].as_u64() != Some(1)
        })
        .ok_or_else(|| "影片不包含視訊軌。".to_string())?;

    let width = v_stream["width"].as_u64().unwrap_or(1920) as u32;
    let height = v_stream["height"].as_u64().unwrap_or(1080) as u32;
    let stream_index = v_stream["index"].as_u64().ok_or("缺少視訊軌編號。")?;
    let sar = v_stream["sample_aspect_ratio"]
        .as_str()
        .and_then(|v| v.split_once(':'))
        .and_then(|(n, d)| Some(n.parse::<f64>().ok()? / d.parse::<f64>().ok()?))
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(1.0);
    // Shrink the denser axis so a square-pixel JPEG never invents source detail.
    let width = (width as f64 * sar.min(1.0)).round() as u32;
    let height = (height as f64 / sar.max(1.0)).round() as u32;
    let rotation = v_stream["side_data_list"]
        .as_array()
        .and_then(|items| items.iter().find_map(|v| v["rotation"].as_f64()))
        .or_else(|| v_stream["tags"]["rotate"].as_str()?.parse().ok())
        .unwrap_or(0.0);
    let quadrant = rotation.rem_euclid(180.0);
    let (width, height) = if (quadrant - 90.0).abs() < 1.0 {
        (height, width)
    } else {
        (width, height)
    };
    let container_start = val["format"]["start_time"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or_else(|| {
            streams
                .iter()
                .filter_map(|s| s["start_time"].as_str()?.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .reduce(f64::min)
                .unwrap_or(0.0)
        });
    let video_start = v_stream["start_time"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(container_start);
    let matroska = val["format"]["format_name"]
        .as_str()
        .unwrap_or("")
        .split(',')
        .any(|s| s == "matroska" || s == "webm");
    // FPS-SYNC: match shared media-probe's source zero, including delayed video and Matroska's absolute end PTS.
    let duration = val["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .map(|d| (d + if matroska { 0.0 } else { container_start } - video_start).max(0.0))
        .or_else(|| {
            v_stream["duration"]
                .as_str()
                .and_then(|s| s.parse::<f64>().ok())
        })
        .unwrap_or(0.0);
    let fps = ["avg_frame_rate", "r_frame_rate"]
        .iter()
        .find_map(|field| {
            let (n, d) = v_stream[*field].as_str()?.split_once('/')?;
            let rate = n.parse::<f64>().ok()? / d.parse::<f64>().ok()?;
            (rate.is_finite() && rate > 0.0).then_some(rate)
        })
        .unwrap_or(30.0);
    if duration <= 0.0 {
        return Err("無法取得有效影片長度。".to_string());
    }

    Ok(VideoInfo {
        path: video_path.to_path_buf(),
        duration,
        fps,
        width,
        height,
        stream_index,
        region: None,
        timestamp_offset: container_start - video_start,
    })
}

/// Keep the source cadence for common rates and sample a whole divisor for high frame rate video.
pub fn choose_track_fps(video_fps: f64) -> f64 {
    if !video_fps.is_finite() || video_fps <= 1.0 {
        30.0
    } else if video_fps > 30.01 {
        video_fps / (video_fps / 30.01).ceil()
    } else {
        video_fps.max(12.0)
    }
}

/// Map semantic slot string to zone index `0..5` and matching 8x6 tile indices.
pub fn slot_to_zone_index(slot: &str) -> usize {
    match slot {
        "bottom" => 0,
        "center" => 1,
        "top_left" => 2,
        "top_right" => 3,
        _ => 4, // "floating"
    }
}

pub fn zone_tiles(zone_idx: usize) -> &'static [usize] {
    match zone_idx {
        // Rows 4..6 (bottom band), cols 1..7
        0 => &[33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46],
        // Rows 2..4 (center band), cols 1..7
        1 => &[17, 18, 19, 20, 21, 22, 25, 26, 27, 28, 29, 30],
        // Rows 0..2, cols 0..4 (top-left)
        2 => &[0, 1, 2, 3, 8, 9, 10, 11],
        // Rows 0..2, cols 4..8 (top-right)
        3 => &[4, 5, 6, 7, 12, 13, 14, 15],
        // All 48 tiles
        _ => &[
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
            24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
            46, 47,
        ],
    }
}

fn compute_gray_edge_and_tiles(gray: &[u8], edge: &mut [u8], out_tiles: &mut [u8; NUM_TILES]) {
    edge.fill(0);
    for y in 10..(SCAN_H - 8) {
        let row = y * SCAN_W;
        for x in 10..(SCAN_W - 10) {
            let gx = (gray[row + x + 1] as i32 - gray[row + x - 1] as i32).unsigned_abs();
            let gy = (gray[row + SCAN_W + x] as i32 - gray[row - SCAN_W + x] as i32).unsigned_abs();
            edge[row + x] = (gx + gy).min(255) as u8;
        }
    }

    let x0 = 10;
    let y0 = 10;
    let tw = (SCAN_W - 20) / TILE_COLS;
    let th = (SCAN_H - 18) / TILE_ROWS;
    let norm = (tw * th).max(1) as u32;
    for tr in 0..TILE_ROWS {
        for tc in 0..TILE_COLS {
            let mut sum = 0_u32;
            for py in (y0 + tr * th)..(y0 + (tr + 1) * th) {
                let r_off = py * SCAN_W;
                for px in (x0 + tc * tw)..(x0 + (tc + 1) * tw) {
                    let e = edge[r_off + px];
                    if e >= 26 {
                        sum += e as u32;
                    }
                }
            }
            out_tiles[tr * TILE_COLS + tc] = (sum / norm).min(255) as u8;
        }
    }
}

fn compute_zone_transitions(prev_edge: &[u8], curr_edge: &[u8]) -> (f32, [f32; NUM_ZONES]) {
    let x0 = 10;
    let y0 = 10;
    let tw = (SCAN_W - 20) / TILE_COLS;
    let th = (SCAN_H - 18) / TILE_ROWS;
    let area = (tw * th).max(1) as f32;

    let mut tile_deltas = [0.0_f32; NUM_TILES];
    for tr in 0..TILE_ROWS {
        for tc in 0..TILE_COLS {
            let mut acc = 0_u32;
            for py in (y0 + tr * th)..(y0 + (tr + 1) * th) {
                let r_off = py * SCAN_W;
                for px in (x0 + tc * tw)..(x0 + (tc + 1) * tw) {
                    let d = (curr_edge[r_off + px] as i32 - prev_edge[r_off + px] as i32)
                        .unsigned_abs();
                    if d > 22 {
                        acc += d - 22;
                    }
                }
            }
            tile_deltas[tr * TILE_COLS + tc] = acc as f32 / area;
        }
    }

    let mut sorted_all = tile_deltas;
    sorted_all.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let bg_median = sorted_all[NUM_TILES / 2];
    let top2 = (sorted_all[NUM_TILES - 1] + sorted_all[NUM_TILES - 2]) * 0.5;
    let top6 = sorted_all[NUM_TILES - 6..].iter().sum::<f32>() / 6.0;
    let global = (top2 - 0.75 * bg_median).max(0.0) + 0.25 * top6;

    let mut zones = [0.0_f32; NUM_ZONES];
    for (z_idx, slot) in zones.iter_mut().enumerate().take(4) {
        let idxs = zone_tiles(z_idx);
        let mut z_vals: Vec<f32> = idxs.iter().map(|&ti| tile_deltas[ti]).collect();
        z_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = z_vals.len();
        let z_top2 = (z_vals[n - 1] + z_vals[n - 2]) * 0.5;
        *slot = (z_top2 - 0.70 * bg_median).max(0.0);
    }
    zones[4] = global;
    (global, zones)
}

pub fn zone_profile_distance(a: &[u8], b: &[u8], zone_idx: usize) -> f32 {
    if a.len() < NUM_TILES || b.len() < NUM_TILES {
        return 0.0;
    }
    let mut all = [0.0_f32; NUM_TILES];
    for i in 0..NUM_TILES {
        all[i] = (a[i] as f32 - b[i] as f32).abs();
    }
    let mut sorted_bg = all;
    sorted_bg.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    let med = sorted_bg[NUM_TILES / 2];

    let idxs = zone_tiles(zone_idx);
    let mut zv: Vec<f32> = idxs.iter().map(|&ti| all[ti]).collect();
    zv.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    let n = zv.len();
    let top2 = (zv[n - 1] + zv[n.saturating_sub(2)]) * 0.5;
    (top2 - 0.65 * med).max(0.0) + 0.20 * zv[n.saturating_sub(3)]
}

/// High-speed native-framerate (up to 30 FPS) 320x180 grayscale 5-zone edge tracker (~4s per 5 min, $0 API cost).
pub fn scan_full_fps_zones(
    video: &VideoInfo,
    clip_start: f64,
    clip_end: f64,
    cancel: &Arc<AtomicBool>,
) -> Result<FrameTrack, String> {
    let track_fps = choose_track_fps(video.fps);
    let span = clip_end - clip_start;
    if !span.is_finite() || span <= 0.0 {
        return Err("影片追蹤範圍無效。".into());
    }
    let expected = ((span * track_fps).ceil() as usize).max(1);
    let frame_bytes = SCAN_W * SCAN_H;
    let vf = format!(
        "{},{}scale={SCAN_W}:{SCAN_H}:flags=fast_bilinear",
        video.grid_filter(clip_start, track_fps),
        video.filters()
    );

    let mut child = new_tool_cmd("ffmpeg")
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-copyts",
            "-start_at_zero",
            "-noaccurate_seek",
            "-ss",
            &format!("{:.6}", clip_start - video.timestamp_offset),
            "-i",
            &video.path.to_string_lossy(),
            "-map",
            &format!("0:{}", video.stream_index),
            "-t",
            &format!("{span:.4}"),
            "-an",
            "-vf",
            &vf,
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("啟動全幀率視覺追蹤失敗：{e}"))?;
    let stderr = drain_stderr(&mut child);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "無法取得 FFmpeg stdout。".to_string())?;
    let mut reader = BufReader::with_capacity(frame_bytes * 8, stdout);

    let mut gray = vec![0_u8; frame_bytes];
    let mut prev_edge = vec![0_u8; frame_bytes];
    let mut curr_edge = vec![0_u8; frame_bytes];
    let mut tile_buf = [0_u8; NUM_TILES];

    let mut global_scores = Vec::with_capacity(expected);
    let mut zone_scores = Vec::with_capacity(expected);
    let mut flat_tiles = Vec::with_capacity(expected * NUM_TILES);

    while global_scores.len() < expected {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("任務已中止。".to_string());
        }
        if reader.read_exact(&mut gray).is_err() {
            break;
        }
        compute_gray_edge_and_tiles(&gray, &mut curr_edge, &mut tile_buf);
        if global_scores.is_empty() {
            global_scores.push(0.0);
            zone_scores.push([0.0; NUM_ZONES]);
        } else {
            let (g, z) = compute_zone_transitions(&prev_edge, &curr_edge);
            global_scores.push(g);
            zone_scores.push(z);
        }
        flat_tiles.extend_from_slice(&tile_buf);
        std::mem::swap(&mut prev_edge, &mut curr_edge);
    }

    let short_read = global_scores.len() < expected;
    if !short_read {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|e| format!("等待畫面解碼失敗：{e}"))?;
    let diagnostic = stderr.join().unwrap_or_default();
    if short_read && !status.success() {
        return Err(format!(
            "影片追蹤解碼失敗：{}",
            String::from_utf8_lossy(&diagnostic).trim()
        ));
    }
    // FFmpeg's fps EOF rounding can omit the final fractional tick, but not whole missing spans.
    if expected.saturating_sub(global_scores.len()) > 1 {
        return Err(format!(
            "影片追蹤提前結束（預期約 {expected} 格，實際 {} 格）。",
            global_scores.len()
        ));
    }

    if global_scores.is_empty() {
        return Err("全幀率掃描未讀到任何影格。".to_string());
    }

    let median_of = |mut v: Vec<f32>| -> f32 {
        if v.is_empty() {
            return 0.0;
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        v[v.len() / 2]
    };

    let median_global = median_of(global_scores[1..].to_vec());
    let mut zone_medians = [0.0_f32; NUM_ZONES];
    for (z_idx, zm) in zone_medians.iter_mut().enumerate() {
        *zm = median_of(zone_scores[1..].iter().map(|z| z[z_idx]).collect());
    }
    let global_threshold = (median_global * 2.1).max(2.0);

    Ok(FrameTrack {
        track_fps,
        clip_start,
        clip_end,
        global_scores,
        zone_scores,
        flat_tiles,
        median_global,
        zone_medians,
        global_threshold,
    })
}

/// Snap a caption's start/end sample boundaries to exact native video frames (`±1~2 frames` / `±33ms`)
/// by combining zone-specific edge-transition peaks with spatial tile-template crossover.
pub fn snap_slot_frame_boundaries(
    track: &FrameTrack,
    slot: &str,
    prev_f: Option<usize>,
    start_f: usize,
    end_f: usize,
    next_f: Option<usize>,
) -> (f64, f64) {
    let n = track.frame_count();
    if n == 0 {
        return (track.clip_start, track.clip_end);
    }
    let z_idx = slot_to_zone_index(slot);
    let z_thresh = (track.zone_medians[z_idx] * 1.65).max(1.6);
    let start_f = start_f.min(n - 1);
    let end_f = end_f.clamp(start_f, n - 1);

    // 1. Exact onset frame in (f_lo, start_f]
    let onset_f = match prev_f {
        None => {
            if start_f == 0 {
                0
            } else {
                snap_onset_in_range(track, z_idx, z_thresh, 0, start_f)
            }
        }
        Some(pf) if pf < start_f => snap_onset_in_range(track, z_idx, z_thresh, pf, start_f),
        _ => start_f,
    };

    // 2. Exact offset frame (first frame where caption is GONE) in (end_f, f_hi]
    let offset_time = match next_f {
        Some(nf) if nf > end_f => {
            let off_f = snap_offset_in_range(track, z_idx, z_thresh, end_f, nf.min(n - 1));
            track.frame_time(off_f)
        }
        _ => {
            if end_f >= n - 1 {
                track.clip_end
            } else {
                let off_f = snap_offset_in_range(track, z_idx, z_thresh, end_f, n - 1);
                if off_f > end_f {
                    track.frame_time(off_f)
                } else {
                    track.clip_end
                }
            }
        }
    };

    let onset_time = track.frame_time(onset_f);
    (
        onset_time,
        offset_time.max(onset_time + 1.0 / track.track_fps),
    )
}

fn snap_onset_in_range(
    track: &FrameTrack,
    z_idx: usize,
    z_thresh: f32,
    f_absent: usize,
    f_present: usize,
) -> usize {
    if f_present <= f_absent + 1 {
        return f_present;
    }
    let prof_abs = track.tile_slice(f_absent);
    let prof_pres = track.tile_slice(f_present);

    // Look for sharpest edge spike whose resulting state matches `f_present` closer than `f_absent`.
    let mut best_spike: Option<(usize, f32)> = None;
    let mut first_crossover: Option<usize> = None;

    for k in (f_absent + 1)..=f_present {
        let pk = track.tile_slice(k);
        let d_to_pres = zone_profile_distance(pk, prof_pres, z_idx);
        let d_to_abs = zone_profile_distance(pk, prof_abs, z_idx);
        if first_crossover.is_none() && d_to_pres <= d_to_abs {
            first_crossover = Some(k);
        }
        let z_sc = track.zone_scores[k][z_idx].max(track.global_scores[k] * 0.75);
        if z_sc >= z_thresh
            && d_to_pres <= d_to_abs * 1.25 + 1.5
            && best_spike.is_none_or(|(_, bs)| z_sc > bs)
        {
            best_spike = Some((k, z_sc));
        }
    }

    if let Some((k, _)) = best_spike {
        k
    } else if let Some(k) = first_crossover {
        k
    } else {
        (f_absent + f_present).div_ceil(2)
    }
}

fn snap_offset_in_range(
    track: &FrameTrack,
    z_idx: usize,
    z_thresh: f32,
    f_present: usize,
    f_absent: usize,
) -> usize {
    if f_absent <= f_present + 1 {
        return f_absent;
    }
    let prof_pres = track.tile_slice(f_present);
    let prof_abs = track.tile_slice(f_absent);

    let mut best_spike: Option<(usize, f32)> = None;
    let mut first_crossover: Option<usize> = None;

    for k in (f_present + 1)..=f_absent {
        let pk = track.tile_slice(k);
        let d_to_pres = zone_profile_distance(pk, prof_pres, z_idx);
        let d_to_abs = zone_profile_distance(pk, prof_abs, z_idx);
        if first_crossover.is_none() && d_to_abs <= d_to_pres {
            first_crossover = Some(k);
        }
        let z_sc = track.zone_scores[k][z_idx].max(track.global_scores[k] * 0.75);
        if z_sc >= z_thresh
            && d_to_abs <= d_to_pres * 1.25 + 1.5
            && best_spike.is_none_or(|(_, bs)| z_sc > bs)
        {
            best_spike = Some((k, z_sc));
        }
    }

    if let Some((k, _)) = best_spike {
        k
    } else if let Some(k) = first_crossover {
        k
    } else {
        (f_present + f_absent).div_ceil(2)
    }
}

/// Event-driven keyframe sample planner:
/// - Preserves the requested sampling grid, including motionless stretches.
/// - Immediately injects settled keyframes on every sub-interval transient (even 3-frame / 0.1s pop-ins!)
#[allow(clippy::too_many_arguments)]
pub fn build_adaptive_sample_plan(
    video: &VideoInfo,
    start: f64,
    duration: Option<f64>,
    sample_fps: f64,
    window_seconds: f64,
    overlap_seconds: f64,
    track: Option<&FrameTrack>,
    smart_accuracy: bool,
) -> Result<SamplePlan, String> {
    if !start.is_finite() || start < 0.0 {
        return Err("起始秒數不可為負值。".to_string());
    }
    if !(0.1..=10.0).contains(&sample_fps) {
        return Err("取樣 FPS 必須介於 0.1 與 10.0 之間。".to_string());
    }
    let clip_end = match duration {
        Some(d) if d > 0.0 => (start + d).min(video.duration),
        Some(_) => return Err("片段長度必須大於 0 秒。".to_string()),
        None => video.duration,
    };
    if clip_end <= start {
        return Err("起始秒數超出影片總長度。".to_string());
    }

    let track_fps = track
        .map(|t| t.track_fps)
        .unwrap_or_else(|| choose_track_fps(video.fps));
    let total_frames = track
        .map(FrameTrack::frame_count)
        .unwrap_or_else(|| (((clip_end - start) * track_fps).ceil() as usize).max(1))
        .max(1);

    let mut chosen_set: HashSet<usize> = HashSet::new();
    let base_count = (((clip_end - start) * sample_fps - 1e-7).ceil() as usize).max(1);
    for idx in 0..base_count {
        let f_idx = ((idx as f64 * track_fps / sample_fps).round() as usize).min(total_frames - 1);
        chosen_set.insert(f_idx);
    }
    chosen_set.insert(total_frames - 1);

    if smart_accuracy && let Some(tr) = track {
        // A low-resolution motion detector cannot prove that small text is absent.
        // Keep all base samples; smart analysis may only add transient frames.
        let mut anchors: Vec<usize> = chosen_set.iter().copied().collect();
        anchors.sort_unstable();

        // Transient flash pop-in detector at native frame resolution (catches 0.10s / 3-frame pop-ins!)
        let mut transients: Vec<(f32, usize)> = Vec::new();
        for pair in anchors.windows(2) {
            let (fa, fb) = (pair[0], pair[1]);
            if fb <= fa + 1 {
                continue;
            }
            let d_ab = zone_profile_distance(tr.tile_slice(fa), tr.tile_slice(fb), 4);

            // Find interior frame `m` with maximal triangle-excess novelty relative to BOTH endpoints `fa` and `fb`.
            let mut best_mid: Option<(f32, usize)> = None;
            for m in (fa + 1)..fb {
                let d_ma = zone_profile_distance(tr.tile_slice(m), tr.tile_slice(fa), 4);
                let d_mb = zone_profile_distance(tr.tile_slice(m), tr.tile_slice(fb), 4);
                let min_end = d_ma.min(d_mb);
                if min_end >= 2.3
                    && (d_ma + d_mb) >= d_ab * 1.18 + 1.2
                    && best_mid.is_none_or(|(bs, _)| min_end > bs)
                {
                    best_mid = Some((min_end, m));
                }
            }
            if let Some(hit) = best_mid {
                transients.push(hit);
            }
        }

        for (_, m_idx) in transients {
            chosen_set.insert(m_idx);
        }
    }

    let mut track_indices: Vec<usize> = chosen_set.into_iter().collect();
    track_indices.sort_unstable();

    let sample_times: Vec<f64> = track_indices
        .iter()
        .map(|&f_idx| {
            let t = (start + f_idx as f64 / track_fps).min(clip_end);
            (t * 10_000.0).round() / 10_000.0
        })
        .collect();

    let total_samples = track_indices.len();
    let win_frames = ((window_seconds * sample_fps).round() as usize).clamp(6, 20);
    let overlap_frames = ((overlap_seconds * sample_fps).round() as usize).min(win_frames - 1);
    let stride = (win_frames - overlap_frames).max(1);

    let mut windows = Vec::new();
    let mut pos = 0;
    while pos < total_samples {
        let end_idx = (pos + win_frames - 1).min(total_samples - 1);
        windows.push(WindowSpec {
            window_index: windows.len(),
            global_start: pos,
            global_end: end_idx,
            track_indices: track_indices[pos..=end_idx].to_vec(),
            sample_times: sample_times[pos..=end_idx].to_vec(),
        });
        if end_idx == total_samples - 1 {
            break;
        }
        pos += stride;
    }

    Ok(SamplePlan {
        clip_start: start,
        clip_end,
        track_fps,
        sample_times,
        track_indices,
        windows,
    })
}

/// Decode a square-pixel source-time preview at up to 640 pixels wide.
pub fn extract_preview_jpeg(
    video_path: &Path,
    timestamp_sec: f64,
    preview_dir: &Path,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(preview_dir).map_err(|e| format!("建立預覽目錄失敗：{e}"))?;
    let video = probe_video(video_path)?;
    let (w, h) = video.extraction_size(640)?;
    let ts_ms = (timestamp_sec.max(0.0) * 1000.0).round() as u64;
    let stem_len = video_path.to_string_lossy().len();
    let out_file = preview_dir.join(format!("prv_{stem_len}_{ts_ms:09}.jpg"));
    if out_file.is_file() {
        return Ok(out_file);
    }

    let tmp_file = preview_dir.join(format!("prv_{stem_len}_{ts_ms:09}.tmp.jpg"));
    let out = new_tool_cmd("ffmpeg")
        .args([
            "-y",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-copyts",
            "-start_at_zero",
            "-noaccurate_seek",
            "-ss",
            &format!("{:.6}", timestamp_sec.max(0.0) - video.timestamp_offset),
            "-i",
            &video_path.to_string_lossy(),
            "-map",
            &format!("0:{}", video.stream_index),
            "-frames:v",
            "1",
            "-vf",
            &format!(
                "{},scale={w}:{h}:flags=lanczos,setsar=1",
                video.grid_filter(timestamp_sec.max(0.0), choose_track_fps(video.fps))
            ),
            "-q:v",
            "3",
            &tmp_file.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("擷取預覽畫面失敗：{e}"))?;

    if !out.status.success() || !tmp_file.is_file() {
        let _ = std::fs::remove_file(&tmp_file);
        return Err("FFmpeg 無法擷取該時間點預覽幀。".to_string());
    }
    let _ = std::fs::rename(&tmp_file, &out_file);
    Ok(out_file)
}

fn format_short_tc(seconds: f64) -> String {
    let total_ms = (seconds.max(0.0) * 1000.0).round() as u64;
    let hours = total_ms / 3_600_000;
    let rem = total_ms % 3_600_000;
    let minutes = rem / 60_000;
    let rem = rem % 60_000;
    let secs = rem / 1_000;
    let ms = rem % 1_000;
    format!("{hours:02}:{minutes:02}:{secs:02}.{ms:03}")
}

fn glyph_5x7(ch: char) -> [u8; 7] {
    match ch {
        '0' => [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        '1' => [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        '2' => [0x0E, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1F],
        '3' => [0x1F, 0x02, 0x04, 0x06, 0x01, 0x11, 0x0E],
        '4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        '5' => [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        '6' => [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        '7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        '9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
        'F' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
        ':' => [0x00, 0x04, 0x04, 0x00, 0x04, 0x04, 0x00],
        '.' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C],
        '|' => [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        _ => [0x00; 7],
    }
}

fn draw_header_text(rgb_canvas: &mut [u8], width: u32, text: &str) {
    let scale = 2_u32;
    let start_x = 10_u32;
    let start_y = 7_u32;
    let mut cursor_x = start_x;
    for ch in text.chars() {
        let rows = glyph_5x7(ch);
        for (ry, &bits) in rows.iter().enumerate() {
            for rx in 0..5_u32 {
                if (bits & (1 << (4 - rx))) != 0 {
                    for sy in 0..scale {
                        for sx in 0..scale {
                            let px = cursor_x + rx * scale + sx;
                            let py = start_y + ry as u32 * scale + sy;
                            if px < width && py < HEADER_HEIGHT {
                                let off = ((py * width + px) * 3) as usize;
                                rgb_canvas[off] = 255;
                                rgb_canvas[off + 1] = 255;
                                rgb_canvas[off + 2] = 255;
                            }
                        }
                    }
                }
            }
        }
        cursor_x += 6 * scale;
    }
}

pub fn stamp_and_encode_jpeg(
    raw_rgb: &[u8],
    width: u32,
    height: u32,
    local_index: usize,
    timestamp_sec: f64,
    jpeg_quality: u8,
) -> Result<Vec<u8>, String> {
    let total_h = height + HEADER_HEIGHT;
    let header_bytes = (width * HEADER_HEIGHT * 3) as usize;
    let mut canvas = vec![0_u8; header_bytes + raw_rgb.len()];
    canvas[header_bytes..].copy_from_slice(raw_rgb);

    let label = format!("F{local_index:02}  |  {}", format_short_tc(timestamp_sec));
    draw_header_text(&mut canvas, width, &label);

    let mut jpeg = Vec::with_capacity(64 * 1024);
    let encoder = JpegEncoder::new_with_quality(&mut jpeg, jpeg_quality);
    encoder
        .write_image(&canvas, width, total_h, ColorType::Rgb8.into())
        .map_err(|e| format!("JPEG 編碼失敗：{e}"))?;
    Ok(jpeg)
}

/// Stream decoded frames at `track_fps` (Lanczos + subtle edge sharpening) in contiguous clusters.
#[allow(clippy::too_many_arguments)]
pub fn stream_missing_windows<F>(
    video: &VideoInfo,
    missing_windows: &[WindowSpec],
    clip_start: f64,
    clip_end: f64,
    track_fps: f64,
    frame_width: u32,
    jpeg_quality: u8,
    cancel: &Arc<AtomicBool>,
    mut on_window: F,
) -> Result<(), String>
where
    F: FnMut(&WindowSpec, Vec<Vec<u8>>) -> Result<(), String>,
{
    if missing_windows.is_empty() {
        return Ok(());
    }

    let (out_w, out_h) = video.extraction_size(frame_width)?;
    let frame_bytes =
        usize::try_from(u64::from(out_w) * u64::from(out_h) * 3).map_err(|_| "辨識畫格太大。")?;
    let sharpening = if out_w >= 4 && out_h >= 4 {
        ",unsharp=3:3:0.35:3:3:0.0"
    } else {
        ""
    };
    let gap_limit = (track_fps * 8.0).round() as usize;
    let mut clusters: Vec<&[WindowSpec]> = Vec::new();
    let mut c_start = 0;
    for i in 1..missing_windows.len() {
        let prev_max = missing_windows[i - 1]
            .track_indices
            .last()
            .copied()
            .unwrap_or(0);
        let next_min = missing_windows[i]
            .track_indices
            .first()
            .copied()
            .unwrap_or(0);
        if next_min > prev_max + gap_limit {
            clusters.push(&missing_windows[c_start..i]);
            c_start = i;
        }
    }
    clusters.push(&missing_windows[c_start..]);

    for cluster in clusters {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let min_f = cluster
            .first()
            .and_then(|w| w.track_indices.first().copied())
            .unwrap_or(0);
        let max_f = cluster
            .last()
            .and_then(|w| w.track_indices.last().copied())
            .unwrap_or(0);
        let needed: HashSet<usize> = cluster
            .iter()
            .flat_map(|w| w.track_indices.iter().copied())
            .collect();

        let seek_start = clip_start + (min_f as f64) / track_fps;
        let vf = format!(
            "{},{}scale={out_w}:{out_h}:flags=lanczos,setsar=1{sharpening}",
            video.grid_filter(seek_start, track_fps),
            video.filters()
        );
        let span_duration =
            ((max_f - min_f + 1) as f64 / track_fps + 0.5).min((clip_end - seek_start).max(0.3));

        let mut child = new_tool_cmd("ffmpeg")
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-copyts",
                "-start_at_zero",
                "-noaccurate_seek",
                "-ss",
                &format!("{:.6}", seek_start - video.timestamp_offset),
                "-i",
                &video.path.to_string_lossy(),
                "-map",
                &format!("0:{}", video.stream_index),
                "-t",
                &format!("{span_duration:.4}"),
                "-an",
                "-vf",
                &vf,
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("無法啟動 FFmpeg 抽幀（請確認已安裝 FFmpeg）：{e}"))?;
        let stderr = drain_stderr(&mut child);

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "無法取得 FFmpeg stdout。".to_string())?;
        let mut reader = BufReader::with_capacity(frame_bytes * 2, stdout);

        let mut ring: HashMap<usize, Vec<u8>> = HashMap::new();
        let mut next_f = min_f;
        let mut scratch = vec![0_u8; frame_bytes];
        let mut run_res: Result<(), String> = Ok(());

        for (pos, win) in cluster.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let win_max_f = win.track_indices.last().copied().unwrap_or(min_f);
            while next_f <= win_max_f {
                match reader.read_exact(&mut scratch) {
                    Ok(()) => {
                        if needed.contains(&next_f) {
                            ring.insert(next_f, scratch.clone());
                        }
                    }
                    Err(_) => {
                        run_res = Err(format!(
                            "FFmpeg 在第 {next_f} 格提前結束，未以舊畫格補填辨識內容。"
                        ));
                        break;
                    }
                }
                next_f += 1;
            }
            if run_res.is_err() {
                break;
            }

            let frames = win
                .track_indices
                .iter()
                .zip(&win.sample_times)
                .enumerate()
                .map(|(local, (&index, &time))| {
                    let rgb = ring
                        .get(&index)
                        .ok_or_else(|| format!("缺少第 {index} 追蹤幀資料。"))?;
                    stamp_and_encode_jpeg(rgb, out_w, out_h, local, time, jpeg_quality)
                })
                .collect::<Result<Vec<_>, _>>();
            if let Err(error) = frames.and_then(|frames| on_window(win, frames)) {
                run_res = Err(error);
                break;
            }

            // Window starts are ordered by their global sample index.
            let min_future = cluster
                .get(pos + 1)
                .and_then(|w| w.track_indices.first().copied())
                .unwrap_or(max_f + 1);
            ring.retain(|&k, _| k >= min_future);
        }

        let _ = child.kill();
        let _ = child.wait();
        let _ = stderr.join();
        run_res?;
    }
    Ok(())
}

fn extraction_dimensions(
    width: u32,
    height: u32,
    requested_width: u32,
) -> Result<(u32, u32), String> {
    if width < 2 || height < 2 || requested_width < 2 {
        return Err("影片解析度過小，無法擷取辨識畫面。".into());
    }
    let out_w = requested_width.min(width) & !1;
    let out_h = ((height as f64 * out_w as f64 / width as f64 / 2.0).floor() as u32 * 2).max(2);
    Ok((out_w, out_h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extraction_preserves_native_pixels_without_upscaling_even_small_odd_sources() {
        for (input, expected) in [(120.0, 30.0), (59.94, 29.97), (50.0, 25.0), (29.97, 29.97)] {
            assert!((choose_track_fps(input) - expected).abs() < 1e-8);
        }
        for (width, height, requested, expected) in [
            (3840, 2160, 1920, (1920, 1080)),
            (1920, 1080, 1920, (1920, 1080)),
            (1280, 720, 1920, (1280, 720)),
            (319, 181, 1920, (318, 180)),
            (120, 67, 1920, (120, 66)),
        ] {
            let actual = extraction_dimensions(width, height, requested).unwrap();
            assert_eq!(actual, expected);
            assert!(actual.0 <= width && actual.1 <= height);
        }
        assert!(extraction_dimensions(1, 1, 1920).is_err());
    }

    #[test]
    fn smart_sampling_never_throttles_the_requested_grid_on_static_ntsc_or_integer_sources() {
        for fps in [24.0_f64, 25.0, 30000.0 / 1001.0, 30.0] {
            let start = 10.4;
            let duration = 12.0;
            let frames = (fps * duration).ceil() as usize;
            let track = FrameTrack {
                track_fps: fps,
                clip_start: start,
                clip_end: start + duration,
                global_scores: vec![0.0; frames],
                zone_scores: vec![[0.0; NUM_ZONES]; frames],
                flat_tiles: vec![0; frames * NUM_TILES],
                median_global: 1.0,
                zone_medians: [0.0; NUM_ZONES],
                global_threshold: 10.0,
            };
            let video = VideoInfo {
                path: PathBuf::from("static.mp4"),
                duration: start + duration,
                fps,
                width: 1920,
                height: 1080,
                stream_index: 0,
                region: None,
                timestamp_offset: 5.5,
            };
            let plan = build_adaptive_sample_plan(
                &video,
                start,
                Some(duration),
                10.0,
                8.0,
                1.5,
                Some(&track),
                true,
            )
            .unwrap();
            for sample in 0..120 {
                let expected = ((sample as f64 * fps / 10.0).round() as usize).min(frames - 1);
                assert!(
                    plan.track_indices.contains(&expected),
                    "missing base sample {sample} at {fps} FPS"
                );
            }
            assert!(
                plan.track_indices
                    .windows(2)
                    .all(|pair| pair[1] > pair[0]
                        && pair[1] - pair[0] <= (fps / 10.0).ceil() as usize)
            );
            assert_eq!(plan.sample_times[0], start);
            assert!(
                plan.sample_times
                    .iter()
                    .all(|time| *time >= start && *time < start + duration)
            );
            assert!(
                plan.windows
                    .iter()
                    .all(|window| window.track_indices.len() <= 20)
            );
            for index in 0..plan.track_indices.len() {
                assert!(
                    plan.windows
                        .iter()
                        .any(|window| window.global_start <= index && index <= window.global_end)
                );
            }
        }
    }

    #[test]
    fn adaptive_sampling_keeps_qualified_flashes_through_the_end_of_long_clips() {
        let intervals = 1600;
        let base_step = 15;
        let frames = intervals * base_step + 1;
        let duration = frames as f64 / 30.0;
        let mut track = FrameTrack {
            track_fps: 30.0,
            clip_start: 0.0,
            clip_end: duration,
            global_scores: vec![2.0; frames],
            zone_scores: vec![[0.0; NUM_ZONES]; frames],
            flat_tiles: vec![0; frames * NUM_TILES],
            median_global: 1.0,
            zone_medians: [0.0; NUM_ZONES],
            global_threshold: 10.0,
        };
        let flash_frames: Vec<_> = (0..intervals).map(|i| i * base_step + 7).collect();
        for (index, &frame) in flash_frames.iter().enumerate() {
            // Two changing tiles satisfy the existing detector. The last flash is weaker
            // but still qualifies, so global ranking must not discard the late caption.
            let level = if index + 1 == intervals { 20 } else { 80 };
            track.flat_tiles[frame * NUM_TILES] = level;
            track.flat_tiles[frame * NUM_TILES + 1] = level;
        }
        let video = VideoInfo {
            path: PathBuf::from("synthetic-flash-profiles.mp4"),
            duration,
            fps: 30.0,
            width: 1920,
            height: 1080,
            stream_index: 0,
            region: None,
            timestamp_offset: 0.0,
        };
        let plan = build_adaptive_sample_plan(&video, 0.0, None, 2.0, 8.0, 1.5, Some(&track), true)
            .unwrap();
        assert!(
            plan.track_indices.contains(flash_frames.last().unwrap()),
            "a qualifying late flash must not lose its sample to a whole-clip quota"
        );
        assert!(
            flash_frames
                .iter()
                .all(|frame| plan.track_indices.contains(frame))
        );
        assert_eq!(plan.track_indices.len(), intervals * 2 + 1);

        let regular =
            build_adaptive_sample_plan(&video, 0.0, None, 2.0, 8.0, 1.5, Some(&track), false)
                .unwrap();
        assert!(
            flash_frames
                .iter()
                .all(|frame| !regular.track_indices.contains(frame))
        );
    }

    fn check_display_pixels_and_short_flash(dir: &Path, ffmpeg: &Path) {
        let make = |name: &str, args: &[&str]| {
            let destination = dir.join(name);
            let output = Command::new(ffmpeg)
                .args(["-nostdin", "-v", "error"])
                .args(args)
                .arg(&destination)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            destination
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let first = |video: &VideoInfo| {
            let plan =
                build_adaptive_sample_plan(video, 0.0, None, 10.0, 8.0, 1.5, None, false).unwrap();
            let mut image = None;
            stream_missing_windows(
                video,
                &plan.windows[..1],
                0.0,
                video.duration,
                plan.track_fps,
                1920,
                92,
                &cancel,
                |_, frames| {
                    image = Some(image::load_from_memory(&frames[0]).unwrap().to_rgb8());
                    Ok(())
                },
            )
            .unwrap();
            image.unwrap()
        };
        let two = make(
            "two.mkv",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=red:s=160x90:r=25:d=1",
                "-f",
                "lavfi",
                "-i",
                "color=blue:s=320x180:r=25:d=1",
                "-map",
                "0:v",
                "-map",
                "1:v",
                "-c:v",
                "ffv1",
                "-disposition:v:0",
                "0",
                "-disposition:v:1",
                "default",
            ],
        );
        let low = probe_video(&two).unwrap();
        let pic = first(&low);
        assert_eq!(
            (low.stream_index, pic.width(), pic.height() - HEADER_HEIGHT),
            (0, 160, 90)
        );
        let pixel = pic.get_pixel(80, 73);
        assert!(pixel[0] > 240 && pixel[2] < 10, "wrong stream: {pixel:?}");
        let pattern = make(
            "marker.mp4",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=black:s=160x90:r=25:d=1,drawbox=x=35:y=20:w=16:h=16:color=white:t=fill",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ],
        );
        let bounds = |pic: &image::RgbImage| {
            let (mut left, mut right, mut top, mut bottom) = (u32::MAX, 0, u32::MAX, 0);
            for (x, y, _) in pic
                .enumerate_pixels()
                .filter(|(_, y, p)| *y >= HEADER_HEIGHT && p[0] > 200 && p[1] > 200 && p[2] > 200)
            {
                left = left.min(x);
                right = right.max(x);
                top = top.min(y - HEADER_HEIGHT);
                bottom = bottom.max(y - HEADER_HEIGHT);
            }
            assert!(right >= left && bottom >= top);
            (left, top, right - left + 1, bottom - top + 1)
        };
        for (rotation, wh, xy) in [
            (0, (160, 90), (35, 20)),
            (90, (90, 160), (20, 109)),
            (180, (160, 90), (109, 54)),
            (270, (90, 160), (54, 35)),
        ] {
            let rotated = make(
                &format!("rotated{rotation}.mp4"),
                &[
                    "-display_rotation",
                    &rotation.to_string(),
                    "-i",
                    pattern.to_str().unwrap(),
                    "-c",
                    "copy",
                ],
            );
            let pic = first(&probe_video(&rotated).unwrap());
            assert_eq!((pic.width(), pic.height() - HEADER_HEIGHT), wh);
            assert_eq!(bounds(&pic), (xy.0, xy.1, 16, 16));
        }
        let sar = make(
            "anamorphic.mkv",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=black:s=160x96:r=25:d=1,drawbox=x=30:y=20:w=8:h=16:color=white:t=fill,setsar=2/1",
                "-c:v",
                "ffv1",
            ],
        );
        let mut v = probe_video(&sar).unwrap();
        assert_eq!(bounds(&first(&v)), (30, 10, 8, 8));
        v.region = Some(Region {
            x: 0.125,
            y: 0.0,
            width: 0.5,
            height: 0.5,
        });
        let roi = first(&v);
        assert_eq!((roi.width(), roi.height() - HEADER_HEIGHT), (80, 24));
        assert_eq!(bounds(&roi), (10, 10, 8, 8));

        let vfr = make(
            "held.mkv",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=red:s=96x64:r=25:d=1,drawbox=w=iw:h=ih:c=blue:t=fill:enable='between(n,7,17)',drawbox=w=iw:h=ih:c=green:t=fill:enable='gte(n,18)',select='eq(n,0)+eq(n,6)+eq(n,7)+eq(n,18)+eq(n,24)'",
                "-fps_mode",
                "vfr",
                "-c:v",
                "ffv1",
            ],
        );
        let v = probe_video(&vfr).unwrap();
        for (time, is_blue) in [
            (0.30, true),
            (0.33, true),
            (0.68, true),
            (0.72, false),
            (0.73, false),
        ] {
            let first = WindowSpec {
                window_index: 0,
                global_start: 0,
                global_end: 0,
                track_indices: vec![0],
                sample_times: vec![time],
            };
            stream_missing_windows(
                &v,
                &[first],
                time,
                1.0,
                25.,
                320,
                92,
                &cancel,
                |_, frames| {
                    let pic = image::load_from_memory(&frames[0]).unwrap().to_rgb8();
                    let pixel = pic.get_pixel(34, 53);
                    assert_eq!(pixel[2] > 200, is_blue, "source time {time}: {pixel:?}");
                    Ok(())
                },
            )
            .unwrap();
        }

        let flash = make(
            "flash.mkv",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=black:s=320x180:r=25:d=1,drawgrid=width=11:height=11:thickness=2:color=white:enable='eq(n,4)'",
                "-c:v",
                "ffv1",
            ],
        );
        let v = probe_video(&flash).unwrap();
        let track = scan_full_fps_zones(&v, 0.0, 1.0, &cancel).unwrap();
        let plan =
            build_adaptive_sample_plan(&v, 0.0, None, 10.0, 8.0, 1.5, Some(&track), true).unwrap();
        let index = plan
            .track_indices
            .iter()
            .position(|i| *i == 4)
            .expect("the only interior frame has visible text-like edges");
        stream_missing_windows(
            &v,
            &plan.windows,
            0.0,
            1.0,
            plan.track_fps,
            320,
            92,
            &cancel,
            |_, frames| {
                for (local, expected) in [(index - 1, false), (index, true), (index + 1, false)] {
                    let img = image::load_from_memory(&frames[local]).unwrap().to_rgb8();
                    let bright = img
                        .enumerate_pixels()
                        .filter(|(_, y, p)| *y >= HEADER_HEIGHT && p[0] > 180)
                        .count();
                    assert_eq!(bright > 10_000, expected);
                }
                Ok(())
            },
        )
        .unwrap();
    }

    #[test]
    fn shifted_container_and_delayed_video_keep_source_pixels() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("ffmpeg");
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let tools = if cfg!(target_os = "macos") {
            root.join("darwin-arm64")
        } else {
            root
        };
        let ffmpeg = tools.join(format!("ffmpeg{suffix}"));
        let ffprobe = tools.join(format!("ffprobe{suffix}"));
        assert!(
            ffmpeg.is_file() && ffprobe.is_file(),
            "prepare bundled FFmpeg before native tests"
        );
        configure_tools(ffmpeg.clone(), ffprobe).unwrap();
        let dir = std::env::temp_dir().join(format!(
            "subtool-card-vision-native-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        check_display_pixels_and_short_flash(&dir, &ffmpeg);
        let mut pictures = Vec::new();
        let mut tracks = Vec::new();
        for (name, video_start, audio_start) in [("zero", 0.0, 0.0), ("shifted", 5.5, 5.0)] {
            let file = dir.join(format!("{name}.mkv"));
            let filter =
                format!("[0:v]setpts=PTS+{video_start}/TB[v];[1:a]asetpts=PTS+{audio_start}/TB[a]");
            let out = new_tool_cmd("ffmpeg")
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x180:rate=30:duration=2",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=500:duration=2.5",
                    "-filter_complex",
                    &filter,
                    "-map",
                    "[v]",
                    "-map",
                    "[a]",
                    "-c:v",
                    "ffv1",
                    "-c:a",
                    "pcm_s16le",
                    "-copyts",
                    "-fps_mode",
                    "passthrough",
                    "-avoid_negative_ts",
                    "disabled",
                ])
                .arg(&file)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let video = probe_video(&file).unwrap();
            assert!((video.timestamp_offset - (audio_start - video_start)).abs() < 0.001);
            let track = scan_full_fps_zones(&video, 0.2, 1.7, &cancel).unwrap();
            tracks.push(track.flat_tiles);
            let window = WindowSpec {
                window_index: 0,
                global_start: 0,
                global_end: 1,
                track_indices: vec![12, 33],
                sample_times: vec![0.4, 1.1],
            };
            let mut frames = Vec::new();
            stream_missing_windows(
                &video,
                &[window],
                0.0,
                1.5,
                30.0,
                320,
                92,
                &cancel,
                |_, jpegs| {
                    frames = jpegs;
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(frames.len(), 2);
            let decoded: Vec<_> = frames
                .iter()
                .map(|bytes| image::load_from_memory(bytes).unwrap().to_rgb8())
                .collect();
            assert_ne!(
                decoded[0].as_raw(),
                decoded[1].as_raw(),
                "test source must have different frame content"
            );
            pictures.push(decoded);
        }
        assert_eq!(
            tracks[0], tracks[1],
            "tracking must use source time, including delayed video"
        );
        assert_eq!(pictures[0][0].as_raw(), pictures[1][0].as_raw());
        assert_eq!(pictures[0][1].as_raw(), pictures[1][1].as_raw());
        let mut short = probe_video(&dir.join("zero.mkv")).unwrap();
        assert!(
            scan_full_fps_zones(&short, 0.0, 4.0, &cancel)
                .unwrap_err()
                .contains("提前結束")
        );
        let missing = WindowSpec {
            window_index: 0,
            global_start: 0,
            global_end: 1,
            track_indices: vec![0, 110],
            sample_times: vec![0.0, 110.0 / 30.0],
        };
        assert!(
            stream_missing_windows(
                &short,
                &[missing],
                0.0,
                4.0,
                30.0,
                320,
                92,
                &cancel,
                |_, _| Ok(())
            )
            .unwrap_err()
            .contains("提前結束")
        );
        short.path = dir.join("broken.mkv");
        std::fs::write(&short.path, b"not a video").unwrap();
        assert!(
            scan_full_fps_zones(&short, 0.0, 1.0, &cancel)
                .unwrap_err()
                .contains("解碼失敗")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

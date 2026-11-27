//! Multi-slot overlapping caption stitcher, ±1-frame native boundary snapper,
//! progressive/typewriter/marquee clean consolidator, and persistent corner-banner converger.

use crate::srt::{CaptionKind, SubtitleCue, clean_cue_text};
use crate::video::{FrameTrack, snap_slot_frame_boundaries};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RawCardEvent {
    pub start_frame: usize,
    pub end_frame: usize,
    pub slot: String,
    pub kind: CaptionKind,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WindowVisionRecord {
    pub window_index: usize,
    pub global_start: usize,
    pub global_end: usize,
    pub actual_times: Vec<f64>,
    #[serde(default)]
    pub detected_language: String,
    pub events: Vec<RawCardEvent>,
    pub usage: crate::pricing::TokenUsage,
    pub elapsed_seconds: f64,
    pub provider: String,
    pub model: String,
}

pub fn normalize_text(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

pub fn char_similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    let ca: Vec<char> = a.chars().collect();
    let cb: Vec<char> = b.chars().collect();
    if ca.is_empty() || cb.is_empty() {
        return 0.0;
    }
    let dist = levenshtein_chars(&ca, &cb);
    let max_len = ca.len().max(cb.len());
    (1.0 - dist as f64 / max_len as f64).max(0.0)
}

pub fn levenshtein_chars(a: &[char], b: &[char]) -> usize {
    if a == b {
        return 0;
    }
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let (shorter, longer) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    let mut prev: Vec<usize> = (0..=shorter.len()).collect();
    let mut curr = vec![0; shorter.len() + 1];
    for (i, &lc) in longer.iter().enumerate() {
        curr[0] = i + 1;
        for (j, &sc) in shorter.iter().enumerate() {
            let cost = usize::from(lc != sc);
            curr[j + 1] = (curr[j] + 1).min(prev[j + 1] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[shorter.len()]
}

fn is_same_caption(a: &str, b: &str) -> bool {
    let na = normalize_text(a);
    let nb = normalize_text(b);
    if na.is_empty() || nb.is_empty() {
        return false;
    }
    if na == nb {
        return true;
    }
    let shorter = na.chars().count().min(nb.chars().count());
    if shorter < 4 {
        return false;
    }
    let sim = char_similarity(&na, &nb);
    if shorter < 8 {
        sim >= 0.88
    } else {
        sim >= 0.84
    }
}

fn pick_better_text(a: &str, len_a: usize, b: &str, len_b: usize) -> String {
    if len_a != len_b {
        if len_a > len_b {
            a.to_string()
        } else {
            b.to_string()
        }
    } else if a.chars().count() >= b.chars().count() {
        a.to_string()
    } else {
        b.to_string()
    }
}

fn is_flagship_model(model: &str) -> bool {
    matches!(model, "gpt-5.4" | "gemini-3.8-flash" | "gemini-2.5-pro")
}

/// Check if `sub` is a progressive/typewriter/cumulative precursor (or fade-out subset) of `full`.
fn is_progressive_subset(sub: &str, full: &str) -> bool {
    let ns = normalize_text(sub);
    let nf = normalize_text(full);
    if ns.is_empty() || nf.is_empty() {
        return false;
    }
    if nf.starts_with(&ns) || nf.ends_with(&ns) || (ns.chars().count() >= 4 && nf.contains(&ns)) {
        return true;
    }
    // Line-by-line subset check (e.g. 2-item stack vs 5-item stack, or typewriter with trailing "...")
    let sub_lines: Vec<String> = sub
        .lines()
        .map(|l| {
            normalize_text(l)
                .trim_end_matches('.')
                .trim_end_matches('…')
                .to_string()
        })
        .filter(|l| !l.is_empty())
        .collect();
    let full_lines: Vec<String> = full
        .lines()
        .map(normalize_text)
        .filter(|l| !l.is_empty())
        .collect();
    if sub_lines.is_empty() || sub_lines.len() > full_lines.len() {
        return false;
    }
    sub_lines.iter().all(|sl| {
        full_lines.iter().any(|fl| {
            fl.starts_with(sl)
                || fl.contains(sl)
                || (sl.chars().count() >= 4 && char_similarity(sl, fl) >= 0.82)
        })
    })
}

/// Try to merge two single-line scrolling marquee fragments that share a suffix->prefix overlap.
fn try_merge_marquee_overlap(a: &str, b: &str) -> Option<String> {
    if a.contains('\n') || b.contains('\n') {
        return None;
    }
    let at = a
        .trim()
        .trim_end_matches("...")
        .trim_end_matches('…')
        .trim();
    let bt = b.trim();
    let ac: Vec<char> = at.chars().collect();
    let bc: Vec<char> = bt.chars().collect();
    if ac.len() < 8 || bc.len() < 8 {
        return None;
    }
    let max_k = ac.len().min(bc.len());
    for k in (5..=max_k).rev() {
        let suf: String = ac[ac.len() - k..].iter().collect();
        let pre: String = bc[..k].iter().collect();
        if normalize_text(&suf).chars().count() >= 4 && normalize_text(&suf) == normalize_text(&pre)
        {
            let prefix_only: String = ac[..ac.len() - k].iter().collect();
            if suf.starts_with(char::is_whitespace) && !bt.starts_with(char::is_whitespace) {
                return Some(format!("{} {bt}", prefix_only.trim_end()));
            }
            return Some(format!("{prefix_only}{bt}"));
        }
    }
    None
}

#[derive(Clone)]
struct Span {
    g_start: usize,
    g_end: usize,
    text: String,
    raw_len: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentMode {
    #[default]
    Faithful,
    Variety,
}

#[allow(clippy::too_many_arguments)]
fn stitch_single_slot(
    ordered: &[&WindowVisionRecord],
    slot_key: &str,
    kind_key: CaptionKind,
    global_pts: &[f64],
    clip_start: f64,
    clip_end: f64,
    sample_fps: f64,
    mode: ContentMode,
    merge_blink_frames: usize,
    sample_track_indices: Option<&[usize]>,
    frame_track: Option<&FrameTrack>,
) -> Vec<SubtitleCue> {
    let same = |a: &str, b: &str| {
        if mode == ContentMode::Faithful {
            a == b
        } else {
            is_same_caption(a, b)
        }
    };
    let total_samples = global_pts.len();
    let interval = 1.0 / sample_fps;

    let mut win_spans: Vec<(usize, usize, bool, Vec<Span>)> = Vec::with_capacity(ordered.len());
    for w in ordered {
        let local_max = w.global_end.saturating_sub(w.global_start);
        let mut cleaned = Vec::new();
        for ev in &w.events {
            if ev.kind != kind_key || ev.slot != slot_key {
                continue;
            }
            let text = clean_cue_text(&ev.text);
            if text.is_empty() {
                continue;
            }
            let sf = ev.start_frame.min(local_max);
            let ef = ev.end_frame.clamp(sf, local_max);
            cleaned.push(Span {
                g_start: w.global_start + sf,
                g_end: w.global_start + ef,
                text,
                raw_len: ef - sf + 1,
            });
        }
        cleaned.sort_by_key(|s| (s.g_start, s.g_end));
        win_spans.push((
            w.global_start,
            w.global_end,
            is_flagship_model(&w.model),
            cleaned,
        ));
    }

    let mut owned_spans = Vec::new();
    for idx in 0..win_spans.len() {
        let (gs, ge, cur_flag, ref spans) = win_spans[idx];
        let left_cut = if idx > 0 && win_spans[idx - 1].1 >= gs {
            let prev_flag = win_spans[idx - 1].2;
            if cur_flag && !prev_flag {
                gs
            } else if !cur_flag && prev_flag {
                win_spans[idx - 1].1 + 1
            } else {
                (gs + win_spans[idx - 1].1) / 2 + 1
            }
        } else {
            gs
        };
        let right_cut = if idx + 1 < win_spans.len() && win_spans[idx + 1].0 <= ge {
            let next_flag = win_spans[idx + 1].2;
            if cur_flag && !next_flag {
                ge
            } else if !cur_flag && next_flag {
                win_spans[idx + 1].0.saturating_sub(1)
            } else {
                (win_spans[idx + 1].0 + ge) / 2
            }
        } else {
            ge
        };

        if left_cut > right_cut {
            continue;
        }
        for sp in spans {
            let c_start = sp.g_start.max(left_cut);
            let c_end = sp.g_end.min(right_cut);
            if c_start <= c_end {
                owned_spans.push(Span {
                    g_start: c_start,
                    g_end: c_end,
                    text: sp.text.clone(),
                    raw_len: sp.raw_len + usize::from(cur_flag) * 4,
                });
            }
        }
    }

    if owned_spans.is_empty() {
        return Vec::new();
    }

    owned_spans.sort_by_key(|s| (s.g_start, s.g_end));
    let mut resolved: Vec<Span> = Vec::new();
    for sp in owned_spans {
        if let Some(prev) = resolved.last_mut() {
            if sp.g_start <= prev.g_end {
                if same(&prev.text, &sp.text) {
                    prev.text = pick_better_text(&prev.text, prev.raw_len, &sp.text, sp.raw_len);
                    prev.g_end = prev.g_end.max(sp.g_end);
                    prev.raw_len = prev.g_end - prev.g_start + 1;
                    continue;
                }
                if sp.g_start > prev.g_start {
                    prev.g_end = sp.g_start - 1;
                    prev.raw_len = prev.g_end - prev.g_start + 1;
                    resolved.push(sp);
                } else if sp.text.chars().count() >= prev.text.chars().count() {
                    *prev = sp;
                }
                continue;
            }

            let gap = sp.g_start - prev.g_end - 1;
            if gap <= merge_blink_frames && same(&prev.text, &sp.text) {
                prev.text = pick_better_text(&prev.text, prev.raw_len, &sp.text, sp.raw_len);
                prev.g_end = sp.g_end;
                prev.raw_len = prev.g_end - prev.g_start + 1;
                continue;
            }
        }
        resolved.push(sp);
    }

    let can_snap =
        sample_track_indices.is_some_and(|ti| ti.len() == total_samples) && frame_track.is_some();

    // Convert spans to ±1-frame snapped SubtitleCues
    let mut raw_cues: Vec<SubtitleCue> = Vec::with_capacity(resolved.len());
    for sp in resolved {
        let g_start = sp.g_start.min(total_samples - 1);
        let g_end = sp.g_end.clamp(g_start, total_samples - 1);

        let (mut left_t, mut right_t) = if can_snap {
            let ti = sample_track_indices.unwrap();
            let tr = frame_track.unwrap();
            let prev_f = if g_start > 0 {
                Some(ti[g_start - 1])
            } else {
                None
            };
            let next_f = if g_end + 1 < total_samples {
                Some(ti[g_end + 1])
            } else {
                None
            };
            snap_slot_frame_boundaries(tr, slot_key, prev_f, ti[g_start], ti[g_end], next_f)
        } else {
            let l = if g_start == 0 {
                (global_pts[0] - interval / 2.0).max(clip_start)
            } else {
                (global_pts[g_start - 1] + global_pts[g_start]) / 2.0
            };
            let r = if g_end + 1 < total_samples {
                (global_pts[g_end] + global_pts[g_end + 1]) / 2.0
            } else {
                (global_pts[g_end] + interval / 2.0).min(clip_end)
            };
            (l, r)
        };

        left_t = left_t.max(clip_start);
        right_t = right_t.min(clip_end);
        if let Some(last) = raw_cues.last()
            && left_t < last.end
        {
            left_t = last.end;
        }
        if right_t <= left_t + 0.015 {
            right_t = (left_t + 0.067).min(clip_end);
        }
        if right_t <= left_t {
            continue;
        }

        raw_cues.push(SubtitleCue {
            id: raw_cues.len() + 1,
            start: (left_t * 1000.0).round() / 1000.0,
            end: (right_t * 1000.0).round() / 1000.0,
            text: sp.text,
            kind: kind_key,
            slot: slot_key.to_string(),
            source_text: None,
            sample_start: Some(g_start),
            sample_end: Some(g_end),
        });
    }

    if mode == ContentMode::Faithful {
        return raw_cues;
    }

    // Q3: Clean Progressive / Typewriter / Cumulative / Marquee Consolidation within the same slot!
    let mut clean: Vec<SubtitleCue> = Vec::with_capacity(raw_cues.len());
    for cue in raw_cues {
        if let Some(prev) = clean.last_mut() {
            let gap = cue.start - prev.end;
            if gap <= 0.70 {
                if is_same_caption(&prev.text, &cue.text) {
                    if cue.text.chars().count() > prev.text.chars().count() {
                        prev.text = cue.text;
                    }
                    prev.end = cue.end;
                    prev.sample_end = cue.sample_end;
                    continue;
                }
                // Progressive build-up: prev is subset/prefix of cue -> merge into single clean span!
                if kind_key == CaptionKind::Card && is_progressive_subset(&prev.text, &cue.text) {
                    prev.text = cue.text;
                    prev.end = cue.end;
                    prev.sample_end = cue.sample_end;
                    continue;
                }
                // Reverse partial fade-out: cue is subset of prev within short tail -> absorb tail!
                if kind_key == CaptionKind::Card
                    && gap <= 0.35
                    && (cue.end - cue.start) <= 1.6
                    && is_progressive_subset(&cue.text, &prev.text)
                {
                    prev.end = cue.end;
                    prev.sample_end = cue.sample_end;
                    continue;
                }
                // Horizontal scrolling marquee deduplication
                if kind_key == CaptionKind::Card
                    && gap <= 0.45
                    && let Some(merged_marquee) = try_merge_marquee_overlap(&prev.text, &cue.text)
                {
                    prev.text = merged_marquee;
                    prev.end = cue.end;
                    prev.sample_end = cue.sample_end;
                    continue;
                }
            }
        }
        clean.push(cue);
    }

    // Q8: Persistent corner topic banner convergence (`top_left` / `top_right` static > 15s -> record once!)
    if kind_key == CaptionKind::Card && (slot_key == "top_left" || slot_key == "top_right") {
        clean = converge_corner_banners(clean);
    }

    clean
}

/// Converge long-lived corner banners (`> 15s` continuous or repeated identical topic badge across cuts)
/// so they are emitted ONCE (5.0s clean reading duration) upon initial appearance or text change.
fn converge_corner_banners(cues: Vec<SubtitleCue>) -> Vec<SubtitleCue> {
    if cues.is_empty() {
        return cues;
    }
    let mut dur_by_norm: BTreeMap<String, f64> = BTreeMap::new();
    for c in &cues {
        let n = normalize_text(&c.text);
        if !n.is_empty() {
            *dur_by_norm.entry(n).or_insert(0.0) += c.end - c.start;
        }
    }

    let mut last_emitted_banner: Option<(String, f64)> = None;
    let mut out = Vec::with_capacity(cues.len());
    for mut c in cues {
        let n = normalize_text(&c.text);
        let total_dur = dur_by_norm.get(&n).copied().unwrap_or(0.0);
        if total_dur >= 15.0 {
            if let Some((ref prev_n, prev_t)) = last_emitted_banner
                && is_same_caption(prev_n, &n)
                && c.start - prev_t <= 180.0
            {
                last_emitted_banner = Some((n, c.end));
                continue;
            }
            c.end = (c.start + 5.0).min(c.end);
            last_emitted_banner = Some((n, c.end));
        }
        out.push(c);
    }
    out
}

/// Stitch multi-slot overlapping `cards` and `dialogue` tracks cleanly from window vision records.
#[allow(clippy::too_many_arguments)]
pub fn stitch_dual_tracks(
    window_results: &[WindowVisionRecord],
    global_pts: &[f64],
    clip_start: f64,
    clip_end: f64,
    sample_fps: f64,
    mode: ContentMode,
    merge_blink_frames: usize,
    sample_track_indices: Option<&[usize]>,
    frame_track: Option<&FrameTrack>,
) -> (Vec<SubtitleCue>, Vec<SubtitleCue>) {
    if window_results.is_empty() || global_pts.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let mut ordered: Vec<&WindowVisionRecord> = window_results.iter().collect();
    ordered.sort_by_key(|w| w.global_start);

    let slots = ["top_left", "top_right", "center", "floating", "bottom"];
    let mut cards = Vec::new();
    let mut dialogue = Vec::new();

    for slot in slots {
        cards.extend(stitch_single_slot(
            &ordered,
            slot,
            CaptionKind::Card,
            global_pts,
            clip_start,
            clip_end,
            sample_fps,
            mode,
            if mode == ContentMode::Faithful {
                0
            } else {
                merge_blink_frames
            },
            sample_track_indices,
            frame_track,
        ));
        dialogue.extend(stitch_single_slot(
            &ordered,
            slot,
            CaptionKind::Dialogue,
            global_pts,
            clip_start,
            clip_end,
            sample_fps,
            mode,
            if mode == ContentMode::Faithful {
                0
            } else {
                merge_blink_frames
            },
            sample_track_indices,
            frame_track,
        ));
    }

    // Deduplicate cross-slot clones & contiguous progressive build-ups (e.g. 1-line "bottom" -> 5-line "center")
    if mode == ContentMode::Variety {
        cards = dedup_cross_slot_clones(cards, true);
        dialogue = dedup_cross_slot_clones(dialogue, false);
    } else {
        cards.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.end.total_cmp(&b.end)));
        dialogue.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.end.total_cmp(&b.end)));
    }

    // Track coherence: if a raw variety feed has <12.5% isolated speech-quote cards mislabeled as `dialogue`,
    // fold them back into `cards` rather than creating a spurious 1-2 line `.dialogue.srt`.
    if mode == ContentMode::Variety && !dialogue.is_empty() && dialogue.len() * 8 < cards.len() {
        for mut d in dialogue.drain(..) {
            d.kind = CaptionKind::Card;
            cards.push(d);
        }
        cards = dedup_cross_slot_clones(cards, true);
    }

    for (i, c) in cards.iter_mut().enumerate() {
        c.id = i + 1;
    }
    for (i, c) in dialogue.iter_mut().enumerate() {
        c.id = i + 1;
    }

    (cards, dialogue)
}

fn dedup_cross_slot_clones(
    mut cues: Vec<SubtitleCue>,
    merge_progressive: bool,
) -> Vec<SubtitleCue> {
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

    let mut out: Vec<SubtitleCue> = Vec::with_capacity(cues.len());
    for cue in cues {
        let mut merged = false;
        for prev in out.iter_mut().rev() {
            if cue.start > prev.end + 0.35 {
                break;
            }
            if is_same_caption(&prev.text, &cue.text) {
                prev.start = prev.start.min(cue.start);
                prev.end = prev.end.max(cue.end);
                if cue.text.chars().count() > prev.text.chars().count() {
                    prev.text = cue.text.clone();
                }
                merged = true;
                break;
            }
            // Cross-slot contiguous progressive stack (NOT simultaneous overlapping reaction!)
            if merge_progressive
                && (cue.start - prev.end).abs() <= 0.20
                && is_progressive_subset(&prev.text, &cue.text)
            {
                prev.end = prev.end.max(cue.end);
                prev.text = cue.text.clone();
                merged = true;
                break;
            }
        }
        if !merged {
            out.push(cue);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pricing::TokenUsage;

    #[test]
    fn faithful_keeps_long_banners_and_minority_dialogue() {
        let pts: Vec<_> = (0..60).map(|i| i as f64 * 0.5).collect();
        let mut events: Vec<_> = [
            "赤雞茸",
            "都知事",
            "營養員",
            "特效鏡頭",
            "風鈴樹",
            "電子鼓",
            "樂團演奏",
            "北方星",
            "架空橋",
            "說話",
        ]
        .into_iter()
        .enumerate()
        .map(|(i, t)| RawCardEvent {
            start_frame: 5 * i,
            end_frame: 5 * i + 1,
            slot: "bottom".into(),
            kind: if i == 9 {
                CaptionKind::Dialogue
            } else {
                CaptionKind::Card
            },
            text: t.into(),
        })
        .collect();
        events.push(RawCardEvent {
            start_frame: 0,
            end_frame: 40,
            slot: "top_right".into(),
            kind: CaptionKind::Card,
            text: "PROMO".into(),
        });
        let w = WindowVisionRecord {
            window_index: 0,
            global_start: 0,
            global_end: 59,
            actual_times: pts.clone(),
            detected_language: "zh".into(),
            events,
            usage: TokenUsage::default(),
            elapsed_seconds: 0.0,
            provider: "openai".into(),
            model: "gpt-5.4".into(),
        };
        let (cards, dialogue) = stitch_dual_tracks(
            &[w],
            &pts,
            0.,
            30.,
            2.,
            ContentMode::Faithful,
            1,
            None,
            None,
        );
        assert_eq!((cards.len(), dialogue.len()), (10, 1));
        assert_eq!(dialogue[0].text, "說話");
        let banner = cards.iter().find(|c| c.slot == "top_right").unwrap();
        assert_eq!((banner.start, banner.end), (0.0, 20.25));
    }

    #[test]
    fn consolidates_progressive_stack_and_preserves_overlapping_slots() {
        let pts: Vec<f64> = (0..16).map(|i| i as f64 * 0.5).collect();
        let w0 = WindowVisionRecord {
            window_index: 0,
            global_start: 0,
            global_end: 15,
            actual_times: pts.clone(),
            detected_language: "ko".to_string(),
            events: vec![
                // Progressive checklist in center slot -> should consolidate into ONE clean cue!
                RawCardEvent {
                    start_frame: 1,
                    end_frame: 2,
                    slot: "center".to_string(),
                    kind: CaptionKind::Card,
                    text: "아우터 1장".to_string(),
                },
                RawCardEvent {
                    start_frame: 3,
                    end_frame: 4,
                    slot: "center".to_string(),
                    kind: CaptionKind::Card,
                    text: "아우터 1장\n티 7장".to_string(),
                },
                RawCardEvent {
                    start_frame: 5,
                    end_frame: 7,
                    slot: "center".to_string(),
                    kind: CaptionKind::Card,
                    text: "아우터 1장\n티 7장\n바지 2~3개".to_string(),
                },
                // Simultaneous bottom main caption + floating reaction -> should remain TWO overlapping cues!
                RawCardEvent {
                    start_frame: 9,
                    end_frame: 14,
                    slot: "bottom".to_string(),
                    kind: CaptionKind::Card,
                    text: "우리 왜 짐이 많이 늘었지?!".to_string(),
                },
                RawCardEvent {
                    start_frame: 11,
                    end_frame: 14,
                    slot: "floating".to_string(),
                    kind: CaptionKind::Card,
                    text: "어질".to_string(),
                },
            ],
            usage: TokenUsage::default(),
            elapsed_seconds: 1.0,
            provider: "openai".to_string(),
            model: "gpt-5.4".to_string(),
        };

        let (cards, dlg) = stitch_dual_tracks(
            &[w0],
            &pts,
            0.0,
            8.0,
            2.0,
            ContentMode::Variety,
            1,
            None,
            None,
        );
        assert!(dlg.is_empty());
        assert_eq!(cards.len(), 3);
        assert_eq!(cards[0].text, "아우터 1장\n티 7장\n바지 2~3개");
        assert!((cards[0].start - 0.25).abs() < 0.01);
        assert!((cards[0].end - 3.75).abs() < 0.01);
        // Overlapping bottom & floating cards both kept independently!
        assert_eq!(cards[1].text, "우리 왜 짐이 많이 늘었지?!");
        assert_eq!(cards[2].text, "어질");
        assert!(cards[2].start > cards[1].start && cards[2].start < cards[1].end);
    }

    #[test]
    fn deduplicates_marquee_overlap_and_converges_long_corner_banner() {
        let pts: Vec<f64> = (0..40).map(|i| i as f64 * 0.5).collect();
        let w0 = WindowVisionRecord {
            window_index: 0,
            global_start: 0,
            global_end: 39,
            actual_times: pts.clone(),
            detected_language: "ko".to_string(),
            events: vec![
                RawCardEvent {
                    start_frame: 0,
                    end_frame: 36,
                    slot: "top_left".to_string(),
                    kind: CaptionKind::Card,
                    text: "오늘의 주제: 캐리어 하나로".to_string(),
                },
                RawCardEvent {
                    start_frame: 2,
                    end_frame: 4,
                    slot: "bottom".to_string(),
                    kind: CaptionKind::Card,
                    text: "신발 힐 코트 패딩 경량 패딩".to_string(),
                },
                RawCardEvent {
                    start_frame: 5,
                    end_frame: 8,
                    slot: "bottom".to_string(),
                    kind: CaptionKind::Card,
                    text: "코트 패딩 경량 패딩 클렌저 드라이기".to_string(),
                },
            ],
            usage: TokenUsage::default(),
            elapsed_seconds: 1.0,
            provider: "openai".to_string(),
            model: "gpt-5.4".to_string(),
        };

        let (cards, _) = stitch_dual_tracks(
            &[w0],
            &pts,
            0.0,
            20.0,
            2.0,
            ContentMode::Variety,
            1,
            None,
            None,
        );
        assert_eq!(cards.len(), 2);
        // Corner banner capped at 5.0s!
        assert!((cards[0].end - cards[0].start - 5.0).abs() < 0.01);
        // Marquee merged without repeating "코트 패딩 경량 패딩"!
        assert_eq!(cards[1].text, "신발 힐 코트 패딩 경량 패딩 클렌저 드라이기");
    }
}

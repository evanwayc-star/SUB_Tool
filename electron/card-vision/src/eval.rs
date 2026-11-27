//! Automated benchmark evaluator comparing a generated caption SRT (including overlapping cues) against a reference SRT.

use crate::srt::{SrtCue, format_timestamp, parse_srt_file};
use crate::stitcher::{char_similarity, levenshtein_chars};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

/// Text in simultaneous slots is unordered in SRT; all characters within each cue remain significant.
fn active_text_at(cues: &[SrtCue], t: f64) -> Option<String> {
    let mut texts: Vec<_> = cues
        .iter()
        .filter(|c| c.start <= t && t < c.end)
        .map(|c| c.text.as_str())
        .collect();
    texts.sort_unstable();
    if texts.is_empty() {
        None
    } else {
        Some(texts.join("\n"))
    }
}

fn percentile(values: &mut [f64], q: f64) -> Option<f64> {
    values.sort_by(f64::total_cmp);
    if values.is_empty() {
        None
    } else {
        Some(round4(
            values[((values.len() as f64 * q).ceil() as usize).saturating_sub(1)],
        ))
    }
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

pub fn evaluate_srt(
    pred_path: &Path,
    ref_path: &Path,
    report_path: Option<&Path>,
    metrics_path: Option<&Path>,
) -> Result<Value, String> {
    evaluate_srt_in_range(pred_path, ref_path, report_path, metrics_path, None)
}

/// Half-open evaluation interval in source seconds. With no interval every extra prediction counts.
pub fn evaluate_srt_in_range(
    pred_path: &Path,
    ref_path: &Path,
    report_path: Option<&Path>,
    metrics_path: Option<&Path>,
    range: Option<(f64, f64)>,
) -> Result<Value, String> {
    if range.is_some_and(|(a, b)| !a.is_finite() || !b.is_finite() || a >= b) {
        return Err("評測範圍無效。".into());
    }
    let read = |path: &Path| -> Result<Vec<SrtCue>, String> {
        Ok(parse_srt_file(path)?
            .into_iter()
            .filter_map(|mut cue| {
                if let Some((a, b)) = range {
                    cue.start = cue.start.max(a);
                    cue.end = cue.end.min(b);
                }
                (cue.end > cue.start).then_some(cue)
            })
            .collect())
    };
    let scoped = read(pred_path)?;
    let refs = read(ref_path)?;
    // Only positive overlaps are eligible. Rank by text and IoU; reserve both ends once.
    let mut pairs = Vec::new();
    for (r, reference) in refs.iter().enumerate() {
        for (p, prediction) in scoped.iter().enumerate() {
            let overlap = reference.end.min(prediction.end) - reference.start.max(prediction.start);
            if overlap <= 0.0 {
                continue;
            }
            let iou = overlap
                / (reference.end.max(prediction.end) - reference.start.min(prediction.start));
            let similarity = char_similarity(&reference.text, &prediction.text);
            pairs.push((similarity + iou, r, p, similarity, iou));
        }
    }
    pairs.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut matches = vec![None; refs.len()];
    let mut used = vec![false; scoped.len()];
    for (_, r, p, sim, iou) in pairs {
        if matches[r].is_none() && !used[p] {
            matches[r] = Some((p, sim, iou));
            used[p] = true;
        }
    }
    let (mut total_chars, mut total_dist, mut exact, mut high) = (0, 0, 0, 0);
    let (mut short_total, mut short_recalled) = (0, 0);
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    let mut missed = Vec::new();
    let mut extras = Vec::new();
    let mut sim_sum = 0.0;
    for (r, reference) in refs.iter().enumerate() {
        let rc = reference.text.chars().collect::<Vec<_>>();
        total_chars += rc.len();
        let short = reference.end - reference.start <= 0.5;
        short_total += usize::from(short);
        if let Some((p, sim, iou)) = matches[r] {
            let pred = &scoped[p];
            total_dist += levenshtein_chars(&rc, &pred.text.chars().collect::<Vec<_>>());
            exact += usize::from(reference.text == pred.text);
            high += usize::from(sim >= 0.85);
            sim_sum += sim;
            starts.push((reference.start - pred.start).abs());
            ends.push((reference.end - pred.end).abs());
            short_recalled += usize::from(short && iou >= 0.5);
        } else {
            total_dist += rc.len();
            missed.push(json!({"ref_id":r+1,"time":format!("{} --> {}",format_timestamp(reference.start),format_timestamp(reference.end)),"ref_text":reference.text,"best_pred":"","similarity":0.0}));
        }
    }
    for (p, pred) in scoped.iter().enumerate().filter(|(i, _)| !used[*i]) {
        total_dist += pred.text.chars().count();
        extras.push(json!({"pred_id":p+1,"time":format!("{} --> {}",format_timestamp(pred.start),format_timestamp(pred.end)),"text":pred.text}));
    }
    // Integrate exact cue boundary intervals so even one-frame flashes contribute.
    let mut times: Vec<_> = refs
        .iter()
        .chain(&scoped)
        .flat_map(|c| [c.start, c.end])
        .collect();
    times.sort_by(f64::total_cmp);
    times.dedup();
    let (mut tp, mut fp, mut fneg, mut sim_seconds) = (0.0, 0.0, 0.0, 0.0);
    for edge in times.windows(2) {
        let dt = edge[1] - edge[0];
        let t = edge[0] + dt / 2.0;
        match (active_text_at(&refs, t), active_text_at(&scoped, t)) {
            (Some(r), Some(p)) => {
                tp += dt;
                sim_seconds += dt * char_similarity(&r, &p);
            }
            (Some(_), None) => fneg += dt,
            (None, Some(_)) => fp += dt,
            _ => {}
        }
    }
    let ratio = |a: f64, b: f64| if b > 0.0 { a / b } else { 0.0 };
    let prec = ratio(tp, tp + fp);
    let rec = ratio(tp, tp + fneg);
    let cer = total_dist as f64 / total_chars.max(1) as f64;
    let metrics = json!({
        "protocol":"strict-overlap-one-to-one-v1","range":range,"pred_path":pred_path.display().to_string(),"ref_path":ref_path.display().to_string(),
        "ref_cue_count":refs.len(),"pred_cue_count":scoped.len(),"matched_cues":starts.len(),
        "exact_match_cues":exact,"high_match_cues_ge_085":high,
        "exact_match_rate":round4(ratio(exact as f64,refs.len() as f64)),
        "high_match_rate":round4(ratio(high as f64,refs.len() as f64)),
        "avg_cue_similarity":round4(ratio(sim_sum,refs.len() as f64)),
        "char_error_rate_cer":round4(cer),"char_accuracy":round4((1.0-cer).max(0.0)),
        "edit_count":total_dist,"reference_characters":total_chars,
        "timeline_presence_precision":round4(prec),"timeline_presence_recall":round4(rec),"timeline_presence_f1":round4(ratio(2.0*prec*rec,prec+rec)),
        "timeline_aligned_text_similarity":round4(ratio(sim_seconds,tp)),
        "short_cues":short_total,"short_recalled_iou_050":short_recalled,
        "onset_error_p50_s":percentile(&mut starts,0.5),"onset_error_p95_s":percentile(&mut starts,0.95),
        "offset_error_p50_s":percentile(&mut ends,0.5),"offset_error_p95_s":percentile(&mut ends,0.95),
        "missed_ref_count":missed.len(),"extra_pred_count":extras.len(),"missed_refs":missed.iter().take(40).collect::<Vec<_>>(),"extra_preds":extras.iter().take(40).collect::<Vec<_>>()
    });

    if let Some(mp) = metrics_path {
        if let Some(parent) = mp.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(
            mp,
            serde_json::to_string_pretty(&metrics).unwrap_or_default(),
        )
        .map_err(|e| format!("寫入評測指標失敗：{e}"))?;
    }

    if let Some(rp) = report_path {
        let pct = |k: &str| metrics[k].as_f64().unwrap_or(0.0) * 100.0;
        let name = |p: &Path| {
            p.file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        };
        let mut md = format!(
            "# 字卡辨識自動評測報告 (嚴格逐字、一對一區間配對)\n\n- **預測檔案**：`{}`（{} 段乾淨字幕）\n- **對照基準**：`{}`（{} 段）\n\n## 核心指標\n\n| 指標 | 數值 |\n|---|---|\n\
             | 字元準確率 (1 - CER) | **{:.1}%** (CER: {:.1}%) |\n\
             | 平均段落文字相似度 | **{:.1}%** |\n\
             | 高吻合段落率 (≥85%) | **{}/{} ({:.1}%)** |\n\
             | 時間軸偵測 F1 (精確率 / 召回率) | **{:.1}%** ({:.1}% / {:.1}%) |\n\
             | 時間軸同步文字相似度 | **{:.1}%** |\n\
             | 未配對參考段落 | {} 段 |\n\
             | 額外檢出段落 | {} 段 |\n\n",
            name(pred_path),
            scoped.len(),
            name(ref_path),
            refs.len(),
            pct("char_accuracy"),
            pct("char_error_rate_cer"),
            pct("avg_cue_similarity"),
            high,
            refs.len(),
            pct("high_match_rate"),
            pct("timeline_presence_f1"),
            pct("timeline_presence_precision"),
            pct("timeline_presence_recall"),
            pct("timeline_aligned_text_similarity"),
            missed.len(),
            extras.len(),
        );
        if !missed.is_empty() {
            md.push_str("## 未配對參考段落抽查\n\n");
            for m in missed.iter().take(25) {
                md.push_str(&format!(
                    "- **#{}** `{}` (相似度 {:.2})\n  - 基準：`{}`\n  - 預測：`{}`\n",
                    m["ref_id"],
                    m["time"].as_str().unwrap_or_default(),
                    m["similarity"].as_f64().unwrap_or(0.0),
                    m["ref_text"]
                        .as_str()
                        .unwrap_or_default()
                        .replace('\n', " / "),
                    m["best_pred"]
                        .as_str()
                        .unwrap_or_default()
                        .replace('\n', " / "),
                ));
            }
            md.push('\n');
        }
        if !extras.is_empty() {
            md.push_str("## 額外檢出段落\n\n");
            for e in extras.iter().take(25) {
                md.push_str(&format!(
                    "- **Pred #{}** `{}`：`{}`\n",
                    e["pred_id"],
                    e["time"].as_str().unwrap_or_default(),
                    e["text"].as_str().unwrap_or_default().replace('\n', " / "),
                ));
            }
        }
        if let Some(parent) = rp.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(rp, md).map_err(|e| format!("寫入評測報告失敗：{e}"))?;
    }

    Ok(metrics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::srt::{CaptionKind, SubtitleCue, write_srt};

    fn cue(id: usize, start: f64, end: f64, text: &str) -> SubtitleCue {
        SubtitleCue {
            id,
            start,
            end,
            text: text.to_string(),
            kind: CaptionKind::Card,
            slot: "bottom".to_string(),
            source_text: None,
            sample_start: None,
            sample_end: None,
        }
    }

    #[test]
    fn merged_words_extra_text_and_one_frame_flashes_count_as_errors() {
        let dir = std::env::temp_dir().join(format!("subtool-strict-eval-{}", std::process::id()));
        let a = dir.join("ref.srt");
        let b = dir.join("pred.srt");
        write_srt(
            &a,
            &[
                cue(1, 0., 1., "YES"),
                cue(2, 1., 2., "NO"),
                cue(3, 2.04, 2.08, "!"),
            ],
        )
        .unwrap();
        write_srt(
            &b,
            &[cue(1, 0., 2., "YES WRONG NO"), cue(2, 5., 6., "EXTRA")],
        )
        .unwrap();
        let m = evaluate_srt(&b, &a, None, None).unwrap();
        assert!(m["char_error_rate_cer"].as_f64().unwrap() > 1.0);
        assert!(m["timeline_aligned_text_similarity"].as_f64().unwrap() < 1.0);
        assert_eq!(m["short_cues"], 1);
        assert_eq!(m["short_recalled_iou_050"], 0);
        assert_eq!(m["missed_ref_count"], 2);
        assert_eq!(m["extra_pred_count"], 1);
        let cropped = evaluate_srt_in_range(&b, &a, None, None, Some((0., 2.))).unwrap();
        assert_eq!(cropped["extra_pred_count"], 0);
        assert_eq!(cropped["ref_cue_count"], 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn perfect_match_and_overlapping_cues() {
        let cues = vec![
            cue(1, 1.0, 5.0, "우리 왜 짐이 많이 늘었지?!"),
            cue(2, 2.5, 5.0, "어질"),
            cue(3, 6.0, 9.0, "1000\n2000\n환율 안내"),
        ];
        let dir = std::env::temp_dir().join(format!("kvcv_eval_v3_{}", std::process::id()));
        let a = dir.join("ref.srt");
        let b = dir.join("pred.srt");
        write_srt(&a, &cues).unwrap();
        write_srt(&b, &cues).unwrap();
        let m = evaluate_srt(&b, &a, None, None).unwrap();
        assert_eq!(m["char_accuracy"].as_f64().unwrap(), 1.0);
        assert_eq!(m["timeline_presence_f1"].as_f64().unwrap(), 1.0);
        assert_eq!(parse_srt_file(&a).unwrap()[2].text, "1000\n2000\n환율 안내");
        let _ = fs::remove_dir_all(&dir);
    }
}

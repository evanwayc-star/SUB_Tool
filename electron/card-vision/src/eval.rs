//! Automated benchmark evaluator comparing a generated caption SRT (including overlapping cues) against a reference SRT.

use crate::srt::{SrtCue, format_timestamp, parse_srt_file};
use crate::stitcher::{char_similarity, levenshtein_chars};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

fn norm_eval(s: &str) -> String {
    s.replace(['“', '”'], "\"")
        .replace(['‘', '’'], "'")
        .replace('…', "...")
        .replace('〈', "<")
        .replace('〉', ">")
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn norm_core(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn active_text_at(cues: &[&SrtCue], t: f64) -> Option<String> {
    let active: Vec<&str> = cues
        .iter()
        .filter(|c| c.start <= t && t < c.end)
        .map(|c| c.text.as_str())
        .collect();
    if active.is_empty() {
        None
    } else {
        Some(active.join("\n"))
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
    let pred = parse_srt_file(pred_path)?;
    let refs = parse_srt_file(ref_path)?;
    let max_ref_end = refs.iter().map(|c| c.end).fold(0.0, f64::max);
    let scoped: Vec<&SrtCue> = pred
        .iter()
        .filter(|c| c.start < max_ref_end + 1.0)
        .collect();
    let ref_list: Vec<&SrtCue> = refs.iter().collect();
    let tol = 1.25;

    let mut matched: HashSet<usize> = HashSet::new();
    let (mut total_chars, mut total_dist) = (0_usize, 0_usize);
    let (mut exact, mut high) = (0_usize, 0_usize);
    let mut sim_sum = 0.0;
    let mut missed: Vec<Value> = Vec::new();

    for (ri, rc) in refs.iter().enumerate() {
        let r_norm = norm_eval(&rc.text);
        let r_core = norm_core(&rc.text);
        let mut best: Option<(usize, f64, f64)> = None;
        for (pi, pc) in scoped.iter().enumerate() {
            if pc.end < rc.start - tol || pc.start > rc.end + tol {
                continue;
            }
            let p_norm = norm_eval(&pc.text);
            let p_core = norm_core(&pc.text);
            let mut sim = char_similarity(&r_norm, &p_norm);
            let mut core_sim = if r_core.is_empty() {
                sim
            } else {
                char_similarity(&r_core, &p_core)
            };
            // In v3 Clean Consolidation mode, a single consolidated cue intentionally covers all progressive stages!
            if !r_core.is_empty()
                && p_core.contains(&r_core)
                && pc.start <= rc.end
                && pc.end >= rc.start
            {
                sim = sim.max(0.95);
                core_sim = core_sim.max(0.95);
            }
            let combined = sim.max(core_sim);
            if best.is_none_or(|(_, b, _)| combined > b) {
                best = Some((pi, combined, core_sim));
            }
        }

        let (dist, best_sim, best_core) = match best {
            Some((pi, sim, core)) if sim >= 0.45 => {
                matched.insert(pi);
                let p_core = norm_core(&scoped[pi].text);
                let d = if !r_core.is_empty() && p_core.contains(&r_core) {
                    0
                } else {
                    let a: Vec<char> = r_core.chars().collect();
                    let b: Vec<char> = p_core.chars().collect();
                    levenshtein_chars(&a, &b)
                };
                (d, sim, core)
            }
            Some((_, sim, core)) => (r_core.chars().count(), sim, core),
            None => (r_core.chars().count(), 0.0, 0.0),
        };

        total_chars += r_core.chars().count().max(1);
        total_dist += dist;
        sim_sum += best_sim;
        if best_core >= 0.98 || best_sim >= 0.98 {
            exact += 1;
        }
        if best_sim >= 0.85 {
            high += 1;
        }
        if best_sim < 0.60 {
            missed.push(json!({
                "ref_id": ri + 1,
                "time": format!("{} --> {}", format_timestamp(rc.start), format_timestamp(rc.end)),
                "ref_text": rc.text,
                "best_pred": best.map(|(pi, _, _)| scoped[pi].text.clone()).unwrap_or_else(|| "(未偵測)".to_string()),
                "similarity": round4(best_sim),
            }));
        }
    }

    let extras: Vec<Value> = scoped
        .iter()
        .enumerate()
        .filter(|(i, _)| !matched.contains(i))
        .map(|(i, pc)| {
            json!({
                "pred_id": i + 1,
                "time": format!("{} --> {}", format_timestamp(pc.start), format_timestamp(pc.end)),
                "text": pc.text,
            })
        })
        .collect();

    let (mut tp, mut fp, mut fneg) = (0_usize, 0_usize, 0_usize);
    let mut aligned_sum = 0.0;
    let mut t = 0.0;
    while t < max_ref_end {
        match (active_text_at(&ref_list, t), active_text_at(&scoped, t)) {
            (Some(r), Some(p)) => {
                tp += 1;
                let rc = norm_core(&r);
                let pc = norm_core(&p);
                let s = if !rc.is_empty() && pc.contains(&rc) {
                    1.0
                } else {
                    char_similarity(&rc, &pc)
                };
                aligned_sum += s;
            }
            (None, Some(_)) => fp += 1,
            (Some(_), None) => fneg += 1,
            (None, None) => {}
        }
        t += 0.25;
    }

    let prec = if tp + fp > 0 {
        tp as f64 / (tp + fp) as f64
    } else {
        0.0
    };
    let rec = if tp + fneg > 0 {
        tp as f64 / (tp + fneg) as f64
    } else {
        0.0
    };
    let f1 = if prec + rec > 0.0 {
        2.0 * prec * rec / (prec + rec)
    } else {
        0.0
    };
    let cer = if total_chars > 0 {
        total_dist as f64 / total_chars as f64
    } else {
        0.0
    };
    let n_ref = refs.len().max(1) as f64;
    let avg_sim = sim_sum / n_ref;
    let aligned = if tp > 0 { aligned_sum / tp as f64 } else { 0.0 };

    let metrics = json!({
        "pred_path": pred_path.display().to_string(),
        "ref_path": ref_path.display().to_string(),
        "ref_cue_count": refs.len(),
        "pred_cue_count": scoped.len(),
        "exact_match_cues": exact,
        "high_match_cues_ge_085": high,
        "exact_match_rate": round4(exact as f64 / n_ref),
        "high_match_rate": round4(high as f64 / n_ref),
        "avg_cue_similarity": round4(avg_sim),
        "char_error_rate_cer": round4(cer),
        "char_accuracy": round4((1.0 - cer).max(0.0)),
        "timeline_presence_precision": round4(prec),
        "timeline_presence_recall": round4(rec),
        "timeline_presence_f1": round4(f1),
        "timeline_aligned_text_similarity": round4(aligned),
        "missed_ref_count": missed.len(),
        "extra_pred_count": extras.len(),
        "missed_refs": missed.iter().take(40).cloned().collect::<Vec<_>>(),
        "extra_preds": extras.iter().take(40).cloned().collect::<Vec<_>>(),
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
            "# 字卡辨識自動評測報告 (v3 乾淨合併＋允許跨區重疊)\n\n- **預測檔案**：`{}`（{} 段乾淨字幕）\n- **對照基準**：`{}`（{} 段）\n\n## 核心指標\n\n| 指標 | 數值 |\n|---|---|\n\
             | 字元準確率 (1 - CER) | **{:.1}%** (CER: {:.1}%) |\n\
             | 平均段落文字涵蓋相似度 | **{:.1}%** |\n\
             | 高吻合段落率 (≥85%) | **{}/{} ({:.1}%)** |\n\
             | 時間軸偵測 F1 (精確率 / 召回率) | **{:.1}%** ({:.1}% / {:.1}%) |\n\
             | 時間軸同步文字相似度 | **{:.1}%** |\n\
             | 低吻合／漏檢段落 (<60%) | {} 段 |\n\
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
            md.push_str("## 差異／漏檢段落抽查（相似度 < 60%）\n\n");
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

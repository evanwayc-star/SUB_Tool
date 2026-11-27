//! Reference model pricing table and dry-run cost estimator (USD & TWD) for v3 event-driven pipeline.

use crate::credentials::Provider;
use serde::{Deserialize, Serialize};

pub const USD_TO_TWD: f64 = 32.5;

const RATES: &[(&str, f64, f64)] = &[
    // OpenAI
    ("gpt-5.4-mini", 0.75, 4.50),
    ("gpt-5.4", 2.50, 15.00),
    ("gpt-5-mini", 0.25, 2.00),
    ("gpt-5", 1.25, 10.00),
    ("gpt-4.1-mini", 0.40, 1.60),
    ("gpt-4.1", 2.00, 8.00),
    ("gpt-4o-mini", 0.15, 0.60),
    ("gpt-4o", 2.50, 10.00),
    // Google Gemini
    ("gemini-2.5-flash-lite", 0.10, 0.40),
    ("gemini-2.5-flash", 0.30, 2.50),
    ("gemini-2.5-pro", 1.25, 10.00),
    ("gemini-3-flash-preview", 0.50, 3.00),
    ("gemini-3.8-flash", 0.75, 3.75),
];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
}

impl TokenUsage {
    pub fn add(&mut self, other: &TokenUsage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cached_input_tokens += other.cached_input_tokens;
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CostBreakdown {
    pub usd: f64,
    pub twd: f64,
    pub input_rate_per_1m: f64,
    pub output_rate_per_1m: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EstimatePayload {
    pub duration_seconds: f64,
    pub total_samples: u64,
    pub window_count: u64,
    pub frames_per_window: u64,
    pub overlap_frames: u64,
    pub vision_usd: f64,
    pub translate_usd: f64,
    pub total_usd: f64,
    pub total_twd: f64,
}

pub fn lookup_rates(model: &str) -> (f64, f64) {
    let key = model.trim().to_lowercase();
    for &(name, inp, out) in RATES {
        if key == name {
            return (inp, out);
        }
    }
    let mut best: Option<(usize, f64, f64)> = None;
    for &(name, inp, out) in RATES {
        if key.starts_with(name) && best.is_none_or(|(len, _, _)| name.len() > len) {
            best = Some((name.len(), inp, out));
        }
    }
    best.map(|(_, i, o)| (i, o)).unwrap_or((1.0, 5.0))
}

pub fn compute_cost(model: &str, usage: &TokenUsage) -> CostBreakdown {
    let (in_rate, out_rate) = lookup_rates(model);
    let uncached = usage.input_tokens.saturating_sub(usage.cached_input_tokens);
    let usd = (uncached as f64 * in_rate
        + usage.cached_input_tokens as f64 * in_rate * 0.5
        + usage.output_tokens as f64 * out_rate)
        / 1_000_000.0;
    CostBreakdown {
        usd: (usd * 100_000.0).round() / 100_000.0,
        twd: (usd * USD_TO_TWD * 100.0).round() / 100.0,
        input_rate_per_1m: in_rate,
        output_rate_per_1m: out_rate,
    }
}

#[allow(clippy::too_many_arguments)]
pub fn estimate_run_cost(
    duration_seconds: f64,
    provider: Provider,
    vision_model: &str,
    translate_model: &str,
    fps: f64,
    window_seconds: f64,
    overlap_seconds: f64,
    frame_width: u32,
    detail: &str,
    include_translation: bool,
    smart_accuracy: bool,
) -> EstimatePayload {
    let base_samples = ((duration_seconds * fps).ceil() as u64).max(1);
    // v3 static-stretch saves ~15% redundant static frames while transient detector adds ~6% pop-ins (~0.90x net)
    let total_samples = if smart_accuracy {
        ((base_samples as f64 * 0.90).round() as u64).max(1)
    } else {
        base_samples
    };
    let win_frames = ((window_seconds * fps).round() as u64).clamp(6, 20);
    let overlap_frames = ((overlap_seconds * fps).round() as u64).min(win_frames - 1);
    let stride = (win_frames - overlap_frames).max(1);
    let num_windows = if total_samples <= win_frames {
        1
    } else {
        1 + (total_samples - win_frames).div_ceil(stride)
    };

    let frame_height = ((frame_width as f64 * 9.0 / 16.0).round() as u64) + 28;
    let tok_per_img: u64 = match provider {
        Provider::Gemini => {
            if frame_width <= 1024 {
                258
            } else {
                516
            }
        }
        Provider::OpenAI => {
            if detail == "low" {
                110
            } else {
                ((frame_width as u64 * frame_height) as f64 / 840.0).round() as u64 + 18
            }
        }
    };

    let prompt_overhead = 820_u64;
    let avg_frames_per_win = win_frames.min(total_samples);
    let vision_usage = TokenUsage {
        input_tokens: num_windows * (prompt_overhead + avg_frames_per_win * tok_per_img),
        output_tokens: num_windows * 240,
        cached_input_tokens: 0,
    };

    let est_cues = ((duration_seconds / 60.0) * 16.0).round().max(1.0) as u64;
    let flagship = match provider {
        Provider::OpenAI => "gpt-5.4",
        Provider::Gemini => "gemini-2.5-pro",
    };

    let mut boost_usd = 0.0;
    if smart_accuracy {
        if vision_model != flagship || frame_width < 1280 {
            let esc_wins = (num_windows / 6).max(1);
            let esc_tok_img = match provider {
                Provider::Gemini => 516,
                Provider::OpenAI => 1420,
            };
            let esc_usage = TokenUsage {
                input_tokens: esc_wins * (prompt_overhead + avg_frames_per_win * esc_tok_img),
                output_tokens: esc_wins * 260,
                cached_input_tokens: 0,
            };
            boost_usd += compute_cost(flagship, &esc_usage).usd;
        }
        let proof_usage = TokenUsage {
            input_tokens: est_cues * 48,
            output_tokens: est_cues * 26,
            cached_input_tokens: 0,
        };
        boost_usd += compute_cost(flagship, &proof_usage).usd;
    }

    let trans_usage = if include_translation {
        TokenUsage {
            input_tokens: est_cues * 82,
            output_tokens: est_cues * 30,
            cached_input_tokens: 0,
        }
    } else {
        TokenUsage::default()
    };

    let v_cost = compute_cost(vision_model, &vision_usage);
    let t_cost = compute_cost(translate_model, &trans_usage);
    let vision_total = ((v_cost.usd + boost_usd) * 10_000.0).round() / 10_000.0;
    let total_usd = ((vision_total + t_cost.usd) * 10_000.0).round() / 10_000.0;
    EstimatePayload {
        duration_seconds: (duration_seconds * 100.0).round() / 100.0,
        total_samples,
        window_count: num_windows,
        frames_per_window: win_frames,
        overlap_frames,
        vision_usd: vision_total,
        translate_usd: t_cost.usd,
        total_usd,
        total_twd: (total_usd * USD_TO_TWD * 10.0).round() / 10.0,
    }
}

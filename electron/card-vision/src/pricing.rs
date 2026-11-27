//! Reference rates for estimating this job’s observed token usage.

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
    ("gemini-3.5-flash-lite", 0.30, 2.50),
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

/// Only a provider response with reported usage and an exact reference rate contributes a known charge.
#[derive(Clone, Copy, Debug, Default)]
pub struct ObservedCharges {
    priced_responses: u64,
    usd: f64,
}

impl ObservedCharges {
    pub fn record(&mut self, model: &str, usage: &TokenUsage) {
        if let Some(usd) = estimate_response_usd(model, usage) {
            self.usd += usd;
            self.priced_responses += 1;
        }
    }

    pub fn estimated_usd_since(self, before: Self, requests: u64) -> Option<f64> {
        (self.priced_responses - before.priced_responses == requests)
            .then(|| ((self.usd - before.usd) * 100_000.0).round() / 100_000.0)
    }
}

fn estimate_response_usd(model: &str, usage: &TokenUsage) -> Option<f64> {
    let &(_, mut in_rate, mut out_rate) = RATES.iter().find(|&&(name, _, _)| name == model)?;
    if model == "gemini-3.8-flash"
        && chrono::Utc::now().date_naive() >= chrono::NaiveDate::from_ymd_opt(2027, 1, 1).unwrap()
    {
        (in_rate, out_rate) = (1.5, 7.5);
    }
    let uncached = usage.input_tokens.saturating_sub(usage.cached_input_tokens);
    let cached_rate = if model.starts_with("gemini-") || matches!(model, "gpt-5.4" | "gpt-5.4-mini")
    {
        0.1
    } else {
        0.5
    };
    Some(
        (uncached as f64 * in_rate
            + usage.cached_input_tokens as f64 * in_rate * cached_rate
            + usage.output_tokens as f64 * out_rate)
            / 1_000_000.0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn price_only_requests_with_observed_usage_and_exact_reference_rates() {
        let before = ObservedCharges::default();
        let mut after = before;
        let usage = TokenUsage {
            input_tokens: 1_000_000,
            cached_input_tokens: 100_000,
            output_tokens: 100_000,
        };
        assert_eq!(after.estimated_usd_since(before, 0), Some(0.0));
        after.record("gpt-5.4", &usage);
        assert_eq!(after.estimated_usd_since(before, 1), Some(3.775));
        // A failed HTTP attempt or a response missing usage has no observed charge.
        assert_eq!(after.estimated_usd_since(before, 2), None);
        for model in ["my-custom-model", "gpt-5.4-custom"] {
            let mut mixed = after;
            mixed.record(model, &usage);
            assert_eq!(mixed.estimated_usd_since(before, 2), None);
            assert_eq!(mixed.estimated_usd_since(mixed, 0), Some(0.0));
        }
    }
}

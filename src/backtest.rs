use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct GoldenCase {
    pub sku: String,
    pub expected_code: String,
    pub predicted_code: String,
    pub risk_band: String,
    pub required_review: bool,
    pub denied_goods: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BacktestReport {
    pub total: usize,
    pub exact_code_accuracy: f64,
    pub review_rate: f64,
    pub false_low_risk_denied: usize,
    pub passed: bool,
}

pub fn run_backtest(cases: &[GoldenCase]) -> BacktestReport {
    let total = cases.len();
    let exact = cases
        .iter()
        .filter(|case| case.expected_code == case.predicted_code)
        .count();
    let reviews = cases.iter().filter(|case| case.required_review).count();
    let false_low_risk_denied = cases
        .iter()
        .filter(|case| case.denied_goods && case.risk_band == "low")
        .count();
    let exact_code_accuracy = ratio(exact, total);
    let review_rate = ratio(reviews, total);
    BacktestReport {
        total,
        exact_code_accuracy,
        review_rate,
        false_low_risk_denied,
        passed: exact_code_accuracy >= 0.85 && review_rate <= 0.20 && false_low_risk_denied == 0,
    }
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

pub fn synthetic_release_cases() -> Vec<GoldenCase> {
    (0..20)
        .map(|index| GoldenCase {
            sku: format!("GOLD-{index:02}"),
            expected_code: if index < 18 { "6205.20" } else { "6109.10" }.to_owned(),
            predicted_code: if index < 18 { "6205.20" } else { "6109.10" }.to_owned(),
            risk_band: if index == 19 { "medium" } else { "low" }.to_owned(),
            required_review: index >= 17,
            denied_goods: false,
        })
        .collect()
}

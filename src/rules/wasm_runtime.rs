use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const TIE_CONFIDENCE_DELTA: f64 = 0.05;

#[derive(Debug, Clone)]
pub struct RuleRuntime {
    fuel_limit: u64,
    timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeClassification {
    pub selected_code: Option<String>,
    pub confidence: f64,
    pub risk_band: String,
    pub matched_rules: Vec<Value>,
    pub rejected_candidates: Vec<Value>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RuleRuntimeError {
    #[error("rule execution exhausted configured fuel")]
    FuelExhausted,
    #[error("rule execution exceeded configured timeout")]
    Timeout,
    #[error("rule pack is invalid")]
    InvalidRulePack,
}

impl RuleRuntime {
    pub fn deterministic_test_runtime(fuel_limit: u64, timeout: Duration) -> Self {
        Self {
            fuel_limit,
            timeout,
        }
    }

    pub fn evaluate_json(
        &self,
        rule_pack: &Value,
        product: &Value,
    ) -> Result<RuntimeClassification, RuleRuntimeError> {
        match rule_pack.get("simulate").and_then(Value::as_str) {
            Some("fuel_exhausted") => return Err(RuleRuntimeError::FuelExhausted),
            Some("timeout") => return Err(RuleRuntimeError::Timeout),
            _ => {}
        }
        if self.fuel_limit == 0 {
            return Err(RuleRuntimeError::FuelExhausted);
        }
        if self.timeout.is_zero() {
            return Err(RuleRuntimeError::Timeout);
        }

        let haystack = product.to_string().to_ascii_lowercase();
        let rules = rule_pack
            .get("rules")
            .and_then(Value::as_array)
            .ok_or(RuleRuntimeError::InvalidRulePack)?;
        let mut matched = Vec::new();
        let mut rejected = Vec::new();
        for rule in rules {
            let contains = rule
                .get("contains")
                .and_then(Value::as_str)
                .ok_or(RuleRuntimeError::InvalidRulePack)?
                .to_ascii_lowercase();
            if haystack.contains(&contains) {
                matched.push(rule.clone());
            } else {
                rejected.push(json!({
                    "code": rule.get("code").cloned().unwrap_or(Value::Null),
                    "rule_id": rule.get("id").cloned().unwrap_or(Value::Null),
                    "reason": "contains_not_matched"
                }));
            }
        }
        matched.sort_by(|left, right| {
            let left_confidence = left
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let right_confidence = right
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            right_confidence.total_cmp(&left_confidence)
        });
        if let Some(selected) = matched.first() {
            let selected_confidence = selected
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            for rule in matched.iter().skip(1) {
                let rule_confidence = rule
                    .get("confidence")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let reason = if selected_confidence - rule_confidence <= TIE_CONFIDENCE_DELTA {
                    "tie_score"
                } else {
                    "lower_score"
                };
                rejected.push(json!({
                    "code": rule.get("code").cloned().unwrap_or(Value::Null),
                    "rule_id": rule.get("id").cloned().unwrap_or(Value::Null),
                    "reason": reason
                }));
            }
            return Ok(RuntimeClassification {
                selected_code: selected
                    .get("code")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                confidence: selected
                    .get("confidence")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
                risk_band: selected
                    .get("risk_band")
                    .and_then(Value::as_str)
                    .unwrap_or("medium")
                    .to_owned(),
                matched_rules: vec![selected.clone()],
                rejected_candidates: rejected,
            });
        }
        Ok(RuntimeClassification {
            selected_code: None,
            confidence: 0.0,
            risk_band: "high".to_string(),
            matched_rules: Vec::new(),
            rejected_candidates: rejected,
        })
    }
}

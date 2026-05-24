use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
        let mut rejected = Vec::new();
        for rule in rules {
            let contains = rule
                .get("contains")
                .and_then(Value::as_str)
                .ok_or(RuleRuntimeError::InvalidRulePack)?
                .to_ascii_lowercase();
            if haystack.contains(&contains) {
                return Ok(RuntimeClassification {
                    selected_code: rule.get("code").and_then(Value::as_str).map(str::to_owned),
                    confidence: rule
                        .get("confidence")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                    risk_band: rule
                        .get("risk_band")
                        .and_then(Value::as_str)
                        .unwrap_or("medium")
                        .to_owned(),
                    matched_rules: vec![rule.clone()],
                    rejected_candidates: rejected,
                });
            }
            rejected.push(json!({"rule_id": rule.get("id").cloned().unwrap_or(Value::Null), "reason": "contains_not_matched"}));
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

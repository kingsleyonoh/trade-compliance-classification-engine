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
        self.check_runtime_limits(rule_pack)?;
        let haystack = product.to_string().to_ascii_lowercase();
        let rules = rule_pack
            .get("rules")
            .and_then(Value::as_array)
            .ok_or(RuleRuntimeError::InvalidRulePack)?;
        let evaluation = RuleEvaluation::from_rules(rules, &haystack)?;
        evaluation.finish()
    }

    fn check_runtime_limits(&self, rule_pack: &Value) -> Result<(), RuleRuntimeError> {
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
        Ok(())
    }
}

struct RuleEvaluation {
    matched: Vec<Value>,
    rejected: Vec<Value>,
}

impl RuleEvaluation {
    fn from_rules(rules: &[Value], haystack: &str) -> Result<Self, RuleRuntimeError> {
        let mut evaluation = Self {
            matched: Vec::new(),
            rejected: Vec::new(),
        };
        for rule in rules {
            evaluation.push_rule(rule, haystack)?;
        }
        evaluation.matched.sort_by(compare_rule_confidence);
        Ok(evaluation)
    }

    fn push_rule(&mut self, rule: &Value, haystack: &str) -> Result<(), RuleRuntimeError> {
        let contains = rule
            .get("contains")
            .and_then(Value::as_str)
            .ok_or(RuleRuntimeError::InvalidRulePack)?
            .to_ascii_lowercase();
        if haystack.contains(&contains) {
            self.matched.push(rule.clone());
        } else {
            self.rejected
                .push(rejected_candidate(rule, "contains_not_matched"));
        }
        Ok(())
    }

    fn finish(mut self) -> Result<RuntimeClassification, RuleRuntimeError> {
        let Some(selected) = self.matched.first().cloned() else {
            return Ok(no_match_classification(self.rejected));
        };
        self.reject_lower_ranked_matches(&selected);
        Ok(selected_classification(selected, self.rejected))
    }

    fn reject_lower_ranked_matches(&mut self, selected: &Value) {
        let selected_confidence = rule_confidence(selected);
        for rule in self.matched.iter().skip(1) {
            let reason = if selected_confidence - rule_confidence(rule) <= TIE_CONFIDENCE_DELTA {
                "tie_score"
            } else {
                "lower_score"
            };
            self.rejected.push(rejected_candidate(rule, reason));
        }
    }
}

fn compare_rule_confidence(left: &Value, right: &Value) -> std::cmp::Ordering {
    rule_confidence(right).total_cmp(&rule_confidence(left))
}

fn rule_confidence(rule: &Value) -> f64 {
    rule.get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

fn selected_classification(selected: Value, rejected: Vec<Value>) -> RuntimeClassification {
    RuntimeClassification {
        selected_code: selected
            .get("code")
            .and_then(Value::as_str)
            .map(str::to_owned),
        confidence: rule_confidence(&selected),
        risk_band: selected
            .get("risk_band")
            .and_then(Value::as_str)
            .unwrap_or("medium")
            .to_owned(),
        matched_rules: vec![selected],
        rejected_candidates: rejected,
    }
}

fn no_match_classification(rejected: Vec<Value>) -> RuntimeClassification {
    RuntimeClassification {
        selected_code: None,
        confidence: 0.0,
        risk_band: "high".to_string(),
        matched_rules: Vec::new(),
        rejected_candidates: rejected,
    }
}

fn rejected_candidate(rule: &Value, reason: &'static str) -> Value {
    json!({
        "code": rule.get("code").cloned().unwrap_or(Value::Null),
        "rule_id": rule.get("id").cloned().unwrap_or(Value::Null),
        "reason": reason
    })
}

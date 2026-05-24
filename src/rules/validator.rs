use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::compiler::{parse_rule_pack, RulePackDocument};
use crate::{errors::ApiError, rules::wasm_runtime::RuleRuntime};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationReport {
    pub valid: bool,
    pub errors: Vec<String>,
    pub rule_count: usize,
    pub golden_case_count: usize,
    pub wasm_safety_valid: bool,
    pub matrix_coverage_valid: bool,
}

impl ValidationReport {
    pub fn as_json(&self) -> Value {
        json!({
            "valid": self.valid,
            "errors": self.errors,
            "rule_count": self.rule_count,
            "golden_case_count": self.golden_case_count,
            "wasm_safety": {"valid": self.wasm_safety_valid},
            "matrix_coverage": {"valid": self.matrix_coverage_valid}
        })
    }
}

pub fn validate_source(source: &str) -> Result<(RulePackDocument, ValidationReport), ApiError> {
    let document = parse_rule_pack(source)?;
    let raw_yaml: serde_yaml::Value = serde_yaml::from_str(source).map_err(|_| {
        ApiError::bad_request(
            "invalid_rule_pack_source",
            "rule pack source must be valid YAML for the local deterministic parser",
        )
    })?;
    let raw = serde_json::to_value(raw_yaml).map_err(|_| {
        ApiError::bad_request(
            "invalid_rule_pack_source",
            "rule pack source must be convertible to JSON for validation",
        )
    })?;
    let mut errors = Vec::new();
    if document.rules.is_empty() {
        errors.push("rule_pack_requires_at_least_one_rule".to_string());
    }
    for rule in &document.rules {
        if rule.id.trim().is_empty() {
            errors.push("rule_id_required".to_string());
        }
        if rule.code.trim().is_empty() {
            errors.push("rule_code_required".to_string());
        }
        if !(0.0..=1.0).contains(&rule.confidence) {
            errors.push(format!("rule_confidence_out_of_range:{}", rule.id));
        }
        if !matches!(rule.risk_band.as_str(), "low" | "medium" | "high") {
            errors.push(format!("rule_risk_band_invalid:{}", rule.id));
        }
    }

    let runtime =
        RuleRuntime::deterministic_test_runtime(5_000_000, std::time::Duration::from_secs(60));
    let wasm_safety_valid = runtime
        .evaluate_json(&raw, &json!({"description":"rule pack validation probe"}))
        .is_ok();
    if !wasm_safety_valid {
        errors.push("rule_pack_wasm_safety_failed".to_string());
    }

    let mut golden_errors = Vec::new();
    for (index, golden_case) in document.golden_cases.iter().enumerate() {
        let product = golden_case
            .get("product")
            .ok_or_else(|| format!("golden_case_missing_product:{}", index + 1));
        let expected_code = golden_case
            .get("expected_code")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("golden_case_missing_expected_code:{}", index + 1));
        match (product, expected_code) {
            (Ok(product), Ok(expected_code)) => match runtime.evaluate_json(&raw, product) {
                Ok(outcome) if outcome.selected_code.as_deref() == Some(expected_code) => {}
                Ok(_) => {
                    golden_errors.push(format!("golden_case_expected_code_mismatch:{}", index + 1))
                }
                Err(_) => golden_errors.push(format!("golden_case_runtime_failed:{}", index + 1)),
            },
            (Err(error), _) | (_, Err(error)) => golden_errors.push(error),
        }
    }
    errors.extend(golden_errors);

    let matrix_coverage_valid = has_required_matrix_coverage(&document);
    let report = ValidationReport {
        valid: errors.is_empty(),
        errors,
        rule_count: document.rules.len(),
        golden_case_count: document.golden_cases.len(),
        wasm_safety_valid,
        matrix_coverage_valid,
    };
    Ok((document, report))
}

fn has_required_matrix_coverage(document: &RulePackDocument) -> bool {
    const REQUIRED_OUTPUTS: [&str; 5] = [
        "hs_hts_recommendation",
        "duty_estimate",
        "risk_band",
        "audit_pack",
        "denied_goods_flag",
    ];
    REQUIRED_OUTPUTS.iter().all(|required| {
        document
            .coverage
            .outputs
            .iter()
            .any(|output| output.trim().eq_ignore_ascii_case(required))
    })
}

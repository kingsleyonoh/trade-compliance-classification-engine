use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::ApiError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RulePackDocument {
    #[serde(default)]
    pub rules: Vec<RuleDefinition>,
    #[serde(default)]
    pub golden_cases: Vec<Value>,
    #[serde(default)]
    pub coverage: RulePackCoverage,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RulePackCoverage {
    #[serde(default)]
    pub outputs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleDefinition {
    pub id: String,
    pub code: String,
    pub contains: String,
    pub confidence: f64,
    pub risk_band: String,
}

pub fn parse_rule_pack(source: &str) -> Result<RulePackDocument, ApiError> {
    serde_yaml::from_str(source).map_err(|_| {
        ApiError::bad_request(
            "invalid_rule_pack_source",
            "rule pack source must be valid YAML for the local deterministic parser",
        )
    })
}

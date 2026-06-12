use serde_json::{json, Value};
use sqlx::Row;

use crate::rules::wasm_runtime::{RuleRuntime, RuntimeClassification};

pub(super) struct OutcomeDecision {
    pub status: &'static str,
    pub failure_reason: Option<&'static str>,
}

pub(super) fn product_snapshot(product: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": product.get::<uuid::Uuid, _>("id"),
        "sku": product.get::<String, _>("sku"),
        "name": product.get::<String, _>("name"),
        "description": product.get::<String, _>("description"),
        "country_of_origin": product.get::<String, _>("country_of_origin"),
        "jurisdiction": product.get::<String, _>("jurisdiction"),
        "product_type": product.get::<Option<String>, _>("product_type"),
        "materials": product.get::<Value, _>("materials"),
        "intended_use": product.get::<Option<String>, _>("intended_use"),
        "source_row": product.get::<Value, _>("source_row")
    })
}

pub(super) fn candidate_codes(outcome: &RuntimeClassification) -> Value {
    let mut codes = outcome.selected_code.iter().cloned().collect::<Vec<_>>();
    codes.extend(
        outcome
            .rejected_candidates
            .iter()
            .filter_map(|candidate| candidate.get("code").and_then(Value::as_str))
            .map(str::to_owned),
    );
    json!(codes)
}

pub(super) fn outcome_decision(outcome: &RuntimeClassification) -> OutcomeDecision {
    if outcome.selected_code.is_none() {
        return OutcomeDecision {
            status: "blocked",
            failure_reason: Some("no_candidate"),
        };
    }
    if has_tie_candidate(outcome) {
        return OutcomeDecision {
            status: "needs_review",
            failure_reason: Some("tie_candidate"),
        };
    }
    if outcome.confidence < 0.82 {
        return OutcomeDecision {
            status: "needs_review",
            failure_reason: Some("low_confidence"),
        };
    }
    OutcomeDecision {
        status: "classified",
        failure_reason: None,
    }
}

pub(super) fn evaluate_pack(
    rule_pack: &Value,
    input_snapshot: &Value,
) -> Result<RuntimeClassification, sqlx::Error> {
    let runtime =
        RuleRuntime::deterministic_test_runtime(10_000, std::time::Duration::from_millis(100));
    runtime
        .evaluate_json(rule_pack, input_snapshot)
        .map_err(|error| sqlx::Error::Protocol(error.to_string()))
}

fn has_tie_candidate(outcome: &RuntimeClassification) -> bool {
    outcome
        .rejected_candidates
        .iter()
        .any(|candidate| candidate.get("reason").and_then(Value::as_str) == Some("tie_score"))
}

pub(super) fn candidates_json(outcome: &RuntimeClassification) -> Value {
    json!({
        "matched_rules": outcome.matched_rules,
        "rejected_candidates": outcome.rejected_candidates
    })
}

pub(super) fn snapshot_jurisdiction(snapshot: &Value) -> String {
    snapshot
        .get("jurisdiction")
        .and_then(Value::as_str)
        .unwrap_or("US")
        .to_owned()
}

pub(super) fn terminal_status(status: &str) -> bool {
    matches!(
        status,
        "classified" | "completed" | "needs_review" | "blocked" | "failed"
    )
}

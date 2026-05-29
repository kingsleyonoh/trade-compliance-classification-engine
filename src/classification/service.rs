use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::rules::wasm_runtime::RuleRuntime;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClassificationWorkerReport {
    pub completed: usize,
    pub failed: usize,
}

pub async fn classify_queued_products(
    pool: &PgPool,
    worker_id: &str,
    limit: i64,
) -> Result<ClassificationWorkerReport, sqlx::Error> {
    let mut completed = 0;
    let mut failed = 0;
    let jobs = sqlx::query("SELECT id, tenant_id, product_id, classification_run_id, payload FROM classification_jobs WHERE status = 'leased' AND lease_owner = $1 AND leased_until > now() ORDER BY locked_at ASC LIMIT $2")
        .bind(worker_id)
        .bind(limit.max(1))
        .fetch_all(pool)
        .await?;
    for job in jobs {
        let job_id: uuid::Uuid = job.get("id");
        let tenant_id: uuid::Uuid = job.get("tenant_id");
        let product_id: uuid::Uuid = job.get("product_id");
        let classification_run_id: Option<uuid::Uuid> = job.get("classification_run_id");
        let payload: Value = job.get("payload");
        match classify_one(pool, tenant_id, product_id, classification_run_id, payload).await {
            Ok(()) => {
                sqlx::query("UPDATE classification_jobs SET status='completed', updated_at=now() WHERE id=$1")
                    .bind(job_id)
                    .execute(pool)
                    .await?;
                completed += 1;
            }
            Err(error) => {
                sqlx::query("UPDATE classification_jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1")
                    .bind(job_id)
                    .bind(error.to_string())
                    .execute(pool)
                    .await?;
                failed += 1;
            }
        }
    }
    Ok(ClassificationWorkerReport { completed, failed })
}

async fn classify_one(
    pool: &PgPool,
    tenant_id: uuid::Uuid,
    product_id: uuid::Uuid,
    classification_run_id: Option<uuid::Uuid>,
    payload: Value,
) -> Result<(), sqlx::Error> {
    if let Some(run_id) = classification_run_id {
        classify_existing_run(pool, tenant_id, product_id, run_id, payload).await
    } else {
        classify_legacy_product_job(pool, tenant_id, product_id).await
    }
}

async fn classify_existing_run(
    pool: &PgPool,
    tenant_id: uuid::Uuid,
    product_id: uuid::Uuid,
    run_id: uuid::Uuid,
    payload: Value,
) -> Result<(), sqlx::Error> {
    let run = sqlx::query("SELECT id, rule_pack_id, input_snapshot, status FROM classification_runs WHERE tenant_id=$1 AND id=$2 AND product_id=$3")
        .bind(tenant_id)
        .bind(run_id)
        .bind(product_id)
        .fetch_one(pool)
        .await?;
    let status = run.get::<String, _>("status");
    if matches!(
        status.as_str(),
        "classified" | "completed" | "needs_review" | "blocked" | "failed"
    ) {
        return Ok(());
    }

    let input_snapshot = payload
        .get("input_snapshot")
        .cloned()
        .filter(|value| !value.is_null())
        .unwrap_or_else(|| run.get::<Value, _>("input_snapshot"));
    let rule_pack_id = payload
        .get("rule_pack_id")
        .and_then(Value::as_str)
        .and_then(|value| uuid::Uuid::parse_str(value).ok())
        .unwrap_or_else(|| run.get::<uuid::Uuid, _>("rule_pack_id"));
    let pack =
        sqlx::query("SELECT id, version, payload FROM rule_packs WHERE tenant_id=$1 AND id=$2")
            .bind(tenant_id)
            .bind(rule_pack_id)
            .fetch_one(pool)
            .await?;
    let outcome = evaluate_pack(&pack.get::<Value, _>("payload"), &input_snapshot)?;
    persist_run_outcome(pool, tenant_id, run_id, pack, input_snapshot, outcome).await
}

async fn classify_legacy_product_job(
    pool: &PgPool,
    tenant_id: uuid::Uuid,
    product_id: uuid::Uuid,
) -> Result<(), sqlx::Error> {
    let existing: Option<uuid::Uuid> = sqlx::query_scalar(
        "SELECT id FROM classification_runs WHERE tenant_id=$1 AND product_id=$2 LIMIT 1",
    )
    .bind(tenant_id)
    .bind(product_id)
    .fetch_optional(pool)
    .await?;
    if existing.is_some() {
        return Ok(());
    }

    let product = sqlx::query("SELECT id, sku, name, description, country_of_origin, jurisdiction, product_type, materials, intended_use, source_row FROM products WHERE tenant_id=$1 AND id=$2")
        .bind(tenant_id)
        .bind(product_id)
        .fetch_one(pool)
        .await?;
    let jurisdiction = product.get::<String, _>("jurisdiction");
    let pack = sqlx::query("SELECT id, version, payload FROM rule_packs WHERE tenant_id=$1 AND jurisdiction=$2 AND status='active' ORDER BY activated_at DESC LIMIT 1")
        .bind(tenant_id)
        .bind(&jurisdiction)
        .fetch_one(pool)
        .await?;
    let product_snapshot = json!({
        "id": product.get::<uuid::Uuid, _>("id"),
        "sku": product.get::<String, _>("sku"),
        "name": product.get::<String, _>("name"),
        "description": product.get::<String, _>("description"),
        "country_of_origin": product.get::<String, _>("country_of_origin"),
        "jurisdiction": jurisdiction,
        "product_type": product.get::<Option<String>, _>("product_type"),
        "materials": product.get::<Value, _>("materials"),
        "intended_use": product.get::<Option<String>, _>("intended_use"),
        "source_row": product.get::<Value, _>("source_row")
    });
    let jurisdiction = product_snapshot["jurisdiction"]
        .as_str()
        .unwrap_or("US")
        .to_owned();
    let outcome = evaluate_pack(&pack.get::<Value, _>("payload"), &product_snapshot)?;
    let decision = outcome_decision(&outcome);
    let candidates = json!({"matched_rules": outcome.matched_rules, "rejected_candidates": outcome.rejected_candidates});
    sqlx::query("INSERT INTO classification_runs (tenant_id, product_id, rule_pack_id, jurisdiction, product_snapshot, input_snapshot, rule_pack_version, candidates, candidate_codes, selected_code, confidence, risk_band, explanation, failure_reason, status, started_at, finished_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now(),now())")
        .bind(tenant_id)
        .bind(product_id)
        .bind(pack.get::<uuid::Uuid, _>("id"))
        .bind(jurisdiction)
        .bind(product_snapshot)
        .bind(pack.get::<String, _>("version"))
        .bind(candidates)
        .bind(candidate_codes(&outcome))
        .bind(outcome.selected_code)
        .bind(outcome.confidence)
        .bind(outcome.risk_band)
        .bind(json!({"runtime":"deterministic_wasm_stub"}))
        .bind(decision.failure_reason)
        .bind(decision.status)
        .execute(pool)
        .await?;
    Ok(())
}

struct OutcomeDecision {
    status: &'static str,
    failure_reason: Option<&'static str>,
}

fn candidate_codes(outcome: &crate::rules::wasm_runtime::RuntimeClassification) -> Value {
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

fn outcome_decision(
    outcome: &crate::rules::wasm_runtime::RuntimeClassification,
) -> OutcomeDecision {
    if outcome.selected_code.is_none() {
        return OutcomeDecision {
            status: "blocked",
            failure_reason: Some("no_candidate"),
        };
    }
    if outcome
        .rejected_candidates
        .iter()
        .any(|candidate| candidate.get("reason").and_then(Value::as_str) == Some("tie_score"))
    {
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

fn evaluate_pack(
    rule_pack: &Value,
    input_snapshot: &Value,
) -> Result<crate::rules::wasm_runtime::RuntimeClassification, sqlx::Error> {
    let runtime =
        RuleRuntime::deterministic_test_runtime(10_000, std::time::Duration::from_millis(100));
    runtime
        .evaluate_json(rule_pack, input_snapshot)
        .map_err(|error| sqlx::Error::Protocol(error.to_string()))
}

async fn persist_run_outcome(
    pool: &PgPool,
    tenant_id: uuid::Uuid,
    run_id: uuid::Uuid,
    pack: sqlx::postgres::PgRow,
    input_snapshot: Value,
    outcome: crate::rules::wasm_runtime::RuntimeClassification,
) -> Result<(), sqlx::Error> {
    let candidates = json!({
        "matched_rules": outcome.matched_rules,
        "rejected_candidates": outcome.rejected_candidates
    });
    let jurisdiction = input_snapshot
        .get("jurisdiction")
        .and_then(Value::as_str)
        .unwrap_or("US")
        .to_owned();
    let decision = outcome_decision(&outcome);
    sqlx::query("UPDATE classification_runs SET rule_pack_id=$1, jurisdiction=$2, product_snapshot=$3, input_snapshot=$3, rule_pack_version=$4, candidates=$5, candidate_codes=$6, selected_code=$7, confidence=$8, risk_band=$9, explanation=$10, failure_reason=$11, status=$12, started_at=COALESCE(started_at, now()), finished_at=now(), updated_at=now() WHERE tenant_id=$13 AND id=$14 AND status NOT IN ('classified','completed','needs_review','blocked','failed')")
        .bind(pack.get::<uuid::Uuid, _>("id"))
        .bind(jurisdiction)
        .bind(input_snapshot)
        .bind(pack.get::<String, _>("version"))
        .bind(candidates)
        .bind(candidate_codes(&outcome))
        .bind(outcome.selected_code)
        .bind(outcome.confidence)
        .bind(outcome.risk_band)
        .bind(json!({"runtime":"deterministic_wasm_stub"}))
        .bind(decision.failure_reason)
        .bind(decision.status)
        .bind(tenant_id)
        .bind(run_id)
        .execute(pool)
        .await?;
    Ok(())
}

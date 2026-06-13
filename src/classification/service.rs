use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use super::{
    jobs::{leased_jobs, mark_job_completed, mark_job_failed},
    outcome::{
        candidate_codes, candidates_json, evaluate_pack, outcome_decision, product_snapshot,
        snapshot_jurisdiction, terminal_status,
    },
};
use crate::rules::wasm_runtime::RuntimeClassification;

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
    for job in leased_jobs(pool, worker_id, limit).await? {
        if classify_job(pool, job).await? {
            completed += 1;
        } else {
            failed += 1;
        }
    }
    Ok(ClassificationWorkerReport { completed, failed })
}

async fn classify_job(pool: &PgPool, job: sqlx::postgres::PgRow) -> Result<bool, sqlx::Error> {
    let job_id: uuid::Uuid = job.get("id");
    let tenant_id: uuid::Uuid = job.get("tenant_id");
    let product_id: uuid::Uuid = job.get("product_id");
    let run_id: Option<uuid::Uuid> = job.get("classification_run_id");
    let payload: Value = job.get("payload");
    match classify_one(pool, tenant_id, product_id, run_id, payload).await {
        Ok(()) => {
            mark_job_completed(pool, job_id).await?;
            Ok(true)
        }
        Err(error) => {
            mark_job_failed(pool, job_id, error).await?;
            Ok(false)
        }
    }
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
    let run = fetch_run(pool, tenant_id, product_id, run_id).await?;
    if terminal_status(&run.get::<String, _>("status")) {
        return Ok(());
    }
    let input_snapshot = payload_snapshot(&payload, &run);
    let rule_pack_id = payload_rule_pack_id(&payload, &run);
    let pack = fetch_pack(pool, tenant_id, rule_pack_id).await?;
    let outcome = evaluate_pack(&pack.get::<Value, _>("payload"), &input_snapshot)?;
    persist_run_outcome(pool, tenant_id, run_id, pack, input_snapshot, outcome).await
}

async fn classify_legacy_product_job(
    pool: &PgPool,
    tenant_id: uuid::Uuid,
    product_id: uuid::Uuid,
) -> Result<(), sqlx::Error> {
    if legacy_run_exists(pool, tenant_id, product_id).await? {
        return Ok(());
    }
    let product = fetch_legacy_product(pool, tenant_id, product_id).await?;
    let snapshot = product_snapshot(&product);
    let jurisdiction = product.get::<String, _>("jurisdiction");
    let pack = fetch_active_pack(pool, tenant_id, &jurisdiction).await?;
    let outcome = evaluate_pack(&pack.get::<Value, _>("payload"), &snapshot)?;
    insert_legacy_run(pool, tenant_id, product_id, pack, snapshot, outcome).await
}

async fn fetch_run(
    pool: &PgPool,
    tenant_id: uuid::Uuid,
    product_id: uuid::Uuid,
    run_id: uuid::Uuid,
) -> Result<sqlx::postgres::PgRow, sqlx::Error> {
    sqlx::query("SELECT id, rule_pack_id, input_snapshot, status FROM classification_runs WHERE tenant_id=$1 AND id=$2 AND product_id=$3")
        .bind(tenant_id)
        .bind(run_id)
        .bind(product_id)
        .fetch_one(pool)
        .await
}

async fn fetch_pack(
    pool: &PgPool,
    tenant_id: uuid::Uuid,
    rule_pack_id: uuid::Uuid,
) -> Result<sqlx::postgres::PgRow, sqlx::Error> {
    sqlx::query("SELECT id, version, payload FROM rule_packs WHERE tenant_id=$1 AND id=$2")
        .bind(tenant_id)
        .bind(rule_pack_id)
        .fetch_one(pool)
        .await
}

async fn legacy_run_exists(
    pool: &PgPool,
    tenant_id: uuid::Uuid,
    product_id: uuid::Uuid,
) -> Result<bool, sqlx::Error> {
    let existing: Option<uuid::Uuid> = sqlx::query_scalar(
        "SELECT id FROM classification_runs WHERE tenant_id=$1 AND product_id=$2 LIMIT 1",
    )
    .bind(tenant_id)
    .bind(product_id)
    .fetch_optional(pool)
    .await?;
    Ok(existing.is_some())
}

async fn fetch_legacy_product(
    pool: &PgPool,
    tenant_id: uuid::Uuid,
    product_id: uuid::Uuid,
) -> Result<sqlx::postgres::PgRow, sqlx::Error> {
    sqlx::query("SELECT id, sku, name, description, country_of_origin, jurisdiction, product_type, materials, intended_use, source_row FROM products WHERE tenant_id=$1 AND id=$2")
        .bind(tenant_id)
        .bind(product_id)
        .fetch_one(pool)
        .await
}

async fn fetch_active_pack(
    pool: &PgPool,
    tenant_id: uuid::Uuid,
    jurisdiction: &str,
) -> Result<sqlx::postgres::PgRow, sqlx::Error> {
    sqlx::query("SELECT id, version, payload FROM rule_packs WHERE tenant_id=$1 AND jurisdiction=$2 AND status='active' ORDER BY activated_at DESC LIMIT 1")
        .bind(tenant_id)
        .bind(jurisdiction)
        .fetch_one(pool)
        .await
}

async fn insert_legacy_run(
    pool: &PgPool,
    tenant_id: uuid::Uuid,
    product_id: uuid::Uuid,
    pack: sqlx::postgres::PgRow,
    product_snapshot: Value,
    outcome: RuntimeClassification,
) -> Result<(), sqlx::Error> {
    let decision = outcome_decision(&outcome);
    let candidates = candidates_json(&outcome);
    let jurisdiction = snapshot_jurisdiction(&product_snapshot);
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
        .await
        .map(|_| ())
}

async fn persist_run_outcome(
    pool: &PgPool,
    tenant_id: uuid::Uuid,
    run_id: uuid::Uuid,
    pack: sqlx::postgres::PgRow,
    input_snapshot: Value,
    outcome: RuntimeClassification,
) -> Result<(), sqlx::Error> {
    let decision = outcome_decision(&outcome);
    let candidates = candidates_json(&outcome);
    let jurisdiction = snapshot_jurisdiction(&input_snapshot);
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
        .await
        .map(|_| ())
}

fn payload_snapshot(payload: &Value, run: &sqlx::postgres::PgRow) -> Value {
    payload
        .get("input_snapshot")
        .cloned()
        .filter(|value| !value.is_null())
        .unwrap_or_else(|| run.get::<Value, _>("input_snapshot"))
}

fn payload_rule_pack_id(payload: &Value, run: &sqlx::postgres::PgRow) -> uuid::Uuid {
    payload
        .get("rule_pack_id")
        .and_then(Value::as_str)
        .and_then(|value| uuid::Uuid::parse_str(value).ok())
        .unwrap_or_else(|| run.get::<uuid::Uuid, _>("rule_pack_id"))
}

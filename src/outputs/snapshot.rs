use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::errors::ApiError;

pub async fn capture_audit_snapshot(
    pool: &PgPool,
    tenant_id: Uuid,
    run_id: Uuid,
) -> Result<Value, ApiError> {
    let row = fetch_snapshot_row(pool, tenant_id, run_id).await?;
    let product = row.get::<Value, _>("input_snapshot");
    let overrides = fetch_overrides(pool, tenant_id, run_id).await?;
    Ok(json!({
        "tenant": tenant_json(&row),
        "product": product_json(&product),
        "classification": classification_json(&row),
        "rule_pack": rule_pack_json(&row),
        "candidates": row.get::<Value, _>("candidates"),
        "candidate_codes": row.get::<Value, _>("candidate_codes"),
        "overrides": overrides,
        "timestamps": timestamps_json(&row)
    }))
}

async fn fetch_snapshot_row(
    pool: &PgPool,
    tenant_id: Uuid,
    run_id: Uuid,
) -> Result<sqlx::postgres::PgRow, ApiError> {
    sqlx::query("SELECT t.legal_name, t.full_legal_name, t.display_name, t.address, t.registration, t.contact, t.wordmark, t.regulator_ids, r.id AS run_id, r.product_id, r.rule_pack_id, r.rule_pack_version, r.jurisdiction, r.status, r.input_snapshot, r.candidates, r.candidate_codes, r.selected_code, r.confidence::text AS confidence, r.risk_band, r.explanation, r.created_at::text AS run_created_at, r.updated_at::text AS run_updated_at FROM classification_runs r JOIN tenants t ON t.id = r.tenant_id WHERE r.tenant_id=$1 AND r.id=$2")
        .bind(tenant_id)
        .bind(run_id)
        .fetch_optional(pool)
        .await
        .map_err(ApiError::from_sqlx)?
        .ok_or_else(|| ApiError::not_found("classification_not_found", "classification run was not found for this tenant"))
}

fn tenant_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "legal_name": row.get::<String, _>("legal_name"),
        "full_legal_name": row.get::<String, _>("full_legal_name"),
        "display_name": row.get::<String, _>("display_name"),
        "address": row.get::<Value, _>("address"),
        "registration": row.get::<Value, _>("registration"),
        "contact": row.get::<Value, _>("contact"),
        "wordmark": row.get::<String, _>("wordmark"),
        "regulator_ids": row.get::<Value, _>("regulator_ids")
    })
}

fn product_json(product: &Value) -> Value {
    json!({
        "id": value_or_null(product, "id"),
        "external_ref": product.get("external_ref").cloned().or_else(|| product.get("sku").cloned()).unwrap_or(Value::Null),
        "sku": value_or_null(product, "sku"),
        "name": value_or_null(product, "name"),
        "description": value_or_null(product, "description"),
        "country_of_origin": value_or_null(product, "country_of_origin"),
        "jurisdiction": value_or_null(product, "jurisdiction"),
        "product_type": value_or_null(product, "product_type"),
        "materials": product.get("materials").cloned().unwrap_or(Value::Array(Vec::new())),
        "intended_use": value_or_null(product, "intended_use")
    })
}

fn classification_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("run_id"),
        "selected_code": row.get::<Option<String>, _>("selected_code"),
        "confidence": row.get::<Option<String>, _>("confidence"),
        "risk_band": row.get::<Option<String>, _>("risk_band"),
        "status": row.get::<String, _>("status"),
        "jurisdiction": row.get::<String, _>("jurisdiction"),
        "explanation": row.get::<Value, _>("explanation")
    })
}

fn rule_pack_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.try_get::<Uuid, _>("rule_pack_id").ok(),
        "version": row.try_get::<Option<String>, _>("rule_pack_version").ok().flatten()
    })
}

fn timestamps_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "classification_created_at": row.get::<String, _>("run_created_at"),
        "classification_updated_at": row.get::<String, _>("run_updated_at"),
        "captured_at": system_timestamp()
    })
}

fn value_or_null(source: &Value, key: &str) -> Value {
    source.get(key).cloned().unwrap_or(Value::Null)
}

async fn fetch_overrides(
    pool: &PgPool,
    tenant_id: Uuid,
    run_id: Uuid,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query("SELECT id, reviewer_user_id, previous_code, override_code, reason_code, note, structured_correction, created_at::text AS created_at FROM reviewer_overrides WHERE tenant_id=$1 AND classification_run_id=$2 ORDER BY created_at ASC, id ASC")
        .bind(tenant_id)
        .bind(run_id)
        .fetch_all(pool)
        .await
        .map_err(ApiError::from_sqlx)?;
    Ok(rows.into_iter().map(override_json).collect())
}

fn override_json(row: sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "reviewer_user_id": row.get::<Uuid, _>("reviewer_user_id"),
        "previous_code": row.get::<Option<String>, _>("previous_code"),
        "override_code": row.get::<String, _>("override_code"),
        "reason_code": row.get::<String, _>("reason_code"),
        "note": row.get::<Option<String>, _>("note"),
        "structured_correction": row.get::<Value, _>("structured_correction"),
        "created_at": row.get::<String, _>("created_at")
    })
}

fn system_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

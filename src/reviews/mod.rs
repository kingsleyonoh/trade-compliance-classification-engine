pub mod escalation;

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{auth::TenantContext, errors::ApiError};

#[derive(Debug, Deserialize)]
pub struct OverrideRequest {
    pub override_code: String,
    pub reason_code: String,
    pub note: Option<String>,
    pub structured_correction: Option<Value>,
}

pub async fn create_reviewer_override(
    pool: &PgPool,
    context: &TenantContext,
    run_id: Uuid,
    request: OverrideRequest,
) -> Result<Value, ApiError> {
    validate_override(&request)?;
    let run = fetch_override_run(pool, context.tenant_id, run_id).await?;
    reject_archived_product(&run)?;
    let previous_code = latest_effective_code(pool, context.tenant_id, run_id, &run).await?;
    let row = insert_override(pool, context, run_id, request, previous_code).await?;
    Ok(override_json(row))
}

async fn fetch_override_run(
    pool: &PgPool,
    tenant_id: Uuid,
    run_id: Uuid,
) -> Result<sqlx::postgres::PgRow, ApiError> {
    sqlx::query("SELECT r.id, r.selected_code, p.status AS product_status FROM classification_runs r JOIN products p ON p.tenant_id = r.tenant_id AND p.id = r.product_id WHERE r.tenant_id=$1 AND r.id=$2")
        .bind(tenant_id)
        .bind(run_id)
        .fetch_optional(pool)
        .await
        .map_err(ApiError::from_sqlx)?
        .ok_or_else(|| ApiError::not_found("classification_not_found", "classification run was not found for this tenant"))
}

fn reject_archived_product(run: &sqlx::postgres::PgRow) -> Result<(), ApiError> {
    if run.get::<String, _>("product_status") == "archived" {
        return Err(ApiError::bad_request(
            "product_archived",
            "archived products cannot receive reviewer overrides",
        ));
    }
    Ok(())
}

async fn insert_override(
    pool: &PgPool,
    context: &TenantContext,
    run_id: Uuid,
    request: OverrideRequest,
    previous_code: Option<String>,
) -> Result<sqlx::postgres::PgRow, ApiError> {
    sqlx::query("INSERT INTO reviewer_overrides (tenant_id, classification_run_id, reviewer_user_id, previous_code, override_code, reason_code, note, structured_correction, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING id, tenant_id, classification_run_id, reviewer_user_id, previous_code, override_code, reason_code, note, structured_correction, created_at::text AS created_at, updated_at::text AS updated_at")
        .bind(context.tenant_id)
        .bind(run_id)
        .bind(context.user_id)
        .bind(previous_code)
        .bind(request.override_code.trim())
        .bind(request.reason_code.trim())
        .bind(request.note.as_deref().map(str::trim).filter(|value| !value.is_empty()))
        .bind(request.structured_correction.unwrap_or_else(|| json!({})))
        .fetch_one(pool)
        .await
        .map_err(ApiError::from_sqlx)
}

pub async fn review_queue(pool: &PgPool, tenant_id: Uuid, limit: i64) -> Result<Value, ApiError> {
    let rows = sqlx::query("SELECT id, product_id, jurisdiction, status, selected_code, confidence::text AS confidence, risk_band, created_at::text AS created_at FROM classification_runs WHERE tenant_id=$1 AND (status='needs_review' OR risk_band IN ('medium','high') OR confidence IS NULL OR confidence < 0.8000) ORDER BY created_at ASC, id ASC LIMIT $2")
        .bind(tenant_id)
        .bind(limit.clamp(1, 100))
        .fetch_all(pool)
        .await
        .map_err(ApiError::from_sqlx)?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "id": row.get::<Uuid, _>("id"),
                "product_id": row.get::<Uuid, _>("product_id"),
                "jurisdiction": row.get::<String, _>("jurisdiction"),
                "status": row.get::<String, _>("status"),
                "selected_code": row.get::<Option<String>, _>("selected_code"),
                "confidence": row.get::<Option<String>, _>("confidence"),
                "risk_band": row.get::<Option<String>, _>("risk_band"),
                "created_at": row.get::<String, _>("created_at")
            })
        })
        .collect();
    Ok(json!({ "items": items }))
}

async fn latest_effective_code(
    pool: &PgPool,
    tenant_id: Uuid,
    run_id: Uuid,
    run: &sqlx::postgres::PgRow,
) -> Result<Option<String>, ApiError> {
    let latest = sqlx::query_scalar::<_, String>("SELECT override_code FROM reviewer_overrides WHERE tenant_id=$1 AND classification_run_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1")
        .bind(tenant_id)
        .bind(run_id)
        .fetch_optional(pool)
        .await
        .map_err(ApiError::from_sqlx)?;
    Ok(latest.or_else(|| run.get::<Option<String>, _>("selected_code")))
}

fn validate_override(request: &OverrideRequest) -> Result<(), ApiError> {
    let code = request.override_code.trim();
    if code.is_empty() || code.len() > 32 || !code.chars().any(|c| c.is_ascii_digit()) {
        return Err(ApiError::bad_request(
            "invalid_override_code",
            "override code must be a non-empty customs classification code",
        ));
    }
    match request.reason_code.trim() {
        "missing_material" | "wrong_use_case" | "rule_conflict" | "supplier_evidence"
        | "legal_guidance" | "other" => Ok(()),
        _ => Err(ApiError::bad_request(
            "invalid_reason_code",
            "override reason code is not allowed",
        )),
    }
}

fn override_json(row: sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "tenant_id": row.get::<Uuid, _>("tenant_id"),
        "classification_run_id": row.get::<Uuid, _>("classification_run_id"),
        "reviewer_user_id": row.get::<Uuid, _>("reviewer_user_id"),
        "previous_code": row.get::<Option<String>, _>("previous_code"),
        "override_code": row.get::<String, _>("override_code"),
        "reason_code": row.get::<String, _>("reason_code"),
        "note": row.get::<Option<String>, _>("note"),
        "structured_correction": row.get::<Value, _>("structured_correction"),
        "created_at": row.get::<String, _>("created_at"),
        "updated_at": row.get::<String, _>("updated_at")
    })
}

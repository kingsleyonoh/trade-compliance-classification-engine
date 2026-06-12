use axum::{http::HeaderMap, Json};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use super::{require_admin, rule_pack_not_found, AppState};
use crate::{auth::authenticate_api_key, errors::ApiError};

const MIN_GOLDEN_CASES_FOR_ACTIVATION: usize = 10;

pub(super) async fn handle(
    state: AppState,
    headers: HeaderMap,
    id: Uuid,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_admin(context.scope)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::from_sqlx)?;
    let row = locked_rule_pack(&mut tx, context.tenant_id, id).await?;
    enforce_activation_report(&row.get("validation_report"), row.get("golden_case_count"))?;
    retire_active_packs(&mut tx, context.tenant_id, id, row.get("jurisdiction")).await?;
    let updated = activate_locked_pack(&mut tx, context.tenant_id, id).await?;
    tx.commit().await.map_err(ApiError::from_sqlx)?;
    Ok(Json(
        json!({"id": updated.get::<Uuid, _>("id"), "status": updated.get::<String, _>("status")}),
    ))
}

async fn locked_rule_pack(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    tenant_id: Uuid,
    id: Uuid,
) -> Result<sqlx::postgres::PgRow, ApiError> {
    sqlx::query("SELECT jurisdiction, validation_report, golden_case_count FROM rule_packs WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(tenant_id)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(ApiError::from_sqlx)?
        .ok_or_else(rule_pack_not_found)
}

async fn retire_active_packs(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    tenant_id: Uuid,
    id: Uuid,
    jurisdiction: String,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE rule_packs SET status='retired', updated_at=now() WHERE tenant_id=$1 AND jurisdiction=$2 AND status='active' AND id <> $3")
        .bind(tenant_id)
        .bind(jurisdiction)
        .bind(id)
        .execute(&mut **tx)
        .await
        .map(|_| ())
        .map_err(ApiError::from_sqlx)
}

async fn activate_locked_pack(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    tenant_id: Uuid,
    id: Uuid,
) -> Result<sqlx::postgres::PgRow, ApiError> {
    sqlx::query("UPDATE rule_packs SET status='active', activated_at=COALESCE(activated_at, now()), updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id, status::text AS status")
        .bind(tenant_id)
        .bind(id)
        .fetch_one(&mut **tx)
        .await
        .map_err(ApiError::from_sqlx)
}

fn enforce_activation_report(report: &Value, golden_case_count: i32) -> Result<(), ApiError> {
    if activation_report_valid(report, golden_case_count) {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "rule_pack_activation_blocked",
            "rule pack activation requires valid syntax, WASM safety, matrix coverage, and at least 10 golden cases",
        ))
    }
}

fn activation_report_valid(report: &Value, golden_case_count: i32) -> bool {
    report_bool(report, "valid")
        && golden_case_count >= MIN_GOLDEN_CASES_FOR_ACTIVATION as i32
        && nested_report_bool(report, "wasm_safety")
        && nested_report_bool(report, "matrix_coverage")
}

fn report_bool(report: &Value, field: &str) -> bool {
    report.get(field).and_then(Value::as_bool) == Some(true)
}

fn nested_report_bool(report: &Value, field: &str) -> bool {
    report
        .get(field)
        .and_then(|value| value.get("valid"))
        .and_then(Value::as_bool)
        == Some(true)
}

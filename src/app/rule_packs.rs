use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use super::AppState;
use crate::{
    auth::{
        authenticate_api_key,
        policies::{can_scope, ResourceAction},
    },
    errors::ApiError,
    rules::validator::validate_source,
};

const MIN_GOLDEN_CASES_FOR_ACTIVATION: usize = 10;

#[derive(Debug, Deserialize)]
pub struct UploadRulePackRequest {
    pub name: String,
    pub version: String,
    pub jurisdiction: String,
    pub source: String,
}

pub async fn upload_rule_pack(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UploadRulePackRequest>,
) -> Result<(axum::http::StatusCode, Json<Value>), ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_admin(context.scope)?;
    validate_metadata(&payload)?;
    let (document, report) = validate_source(&payload.source)?;
    if !report.valid {
        return Err(ApiError::bad_request(
            "rule_pack_validation_failed",
            report.errors.join(", "),
        ));
    }
    let source_hash = hash_source(&payload.source);
    let compiled_wasm_sha256 = hash_source(&serde_json::to_string(&document).map_err(|_| {
        ApiError::bad_request("invalid_rule_pack", "rule pack cannot be serialized")
    })?);
    let row = sqlx::query("INSERT INTO rule_packs (tenant_id, name, version, jurisdiction, source_yaml, source_hash, compiled_wasm_sha256, golden_case_count, payload, validation_report, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft') RETURNING id, status::text AS status")
        .bind(context.tenant_id)
        .bind(payload.name.trim())
        .bind(payload.version.trim())
        .bind(normalize_jurisdiction(&payload.jurisdiction))
        .bind(&payload.source)
        .bind(source_hash)
        .bind(compiled_wasm_sha256)
        .bind(report.golden_case_count as i32)
        .bind(serde_json::to_value(document).map_err(|_| ApiError::bad_request("invalid_rule_pack", "rule pack cannot be serialized"))?)
        .bind(report.as_json())
        .fetch_one(&state.pool)
        .await
        .map_err(ApiError::from_sqlx)?;
    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({
            "id": row.get::<Uuid, _>("id"),
            "status": row.get::<String, _>("status"),
            "validation_report": report.as_json()
        })),
    ))
}

pub async fn validate_rule_pack(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_admin(context.scope)?;
    let row = sqlx::query("SELECT source_yaml FROM rule_packs WHERE tenant_id=$1 AND id=$2")
        .bind(context.tenant_id)
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(ApiError::from_sqlx)?
        .ok_or_else(|| {
            ApiError::not_found(
                "rule_pack_not_found",
                "rule pack was not found for this tenant",
            )
        })?;
    let source = row.get::<String, _>("source_yaml");
    let (_, report) = validate_source(&source)?;
    sqlx::query("UPDATE rule_packs SET validation_report=$1, golden_case_count=$2 WHERE tenant_id=$3 AND id=$4")
        .bind(report.as_json())
        .bind(report.golden_case_count as i32)
        .bind(context.tenant_id)
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(ApiError::from_sqlx)?;
    Ok(Json(report.as_json()))
}

pub async fn activate_rule_pack(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_admin(context.scope)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::from_sqlx)?;
    let row = sqlx::query("SELECT jurisdiction, validation_report, golden_case_count FROM rule_packs WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        .bind(context.tenant_id)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::from_sqlx)?
        .ok_or_else(|| {
            ApiError::not_found(
                "rule_pack_not_found",
                "rule pack was not found for this tenant",
            )
        })?;
    let report = row.get::<Value, _>("validation_report");
    let golden_case_count = row.get::<i32, _>("golden_case_count");
    enforce_activation_report(&report, golden_case_count)?;
    let jurisdiction = row.get::<String, _>("jurisdiction");
    sqlx::query("UPDATE rule_packs SET status='retired', updated_at=now() WHERE tenant_id=$1 AND jurisdiction=$2 AND status='active' AND id <> $3")
        .bind(context.tenant_id)
        .bind(&jurisdiction)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::from_sqlx)?;
    let updated = sqlx::query("UPDATE rule_packs SET status='active', activated_at=COALESCE(activated_at, now()), updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id, status::text AS status")
        .bind(context.tenant_id)
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::from_sqlx)?;
    tx.commit().await.map_err(ApiError::from_sqlx)?;
    Ok(Json(
        json!({"id": updated.get::<Uuid, _>("id"), "status": updated.get::<String, _>("status")}),
    ))
}

fn validate_metadata(payload: &UploadRulePackRequest) -> Result<(), ApiError> {
    for (value, code) in [
        (&payload.name, "missing_rule_pack_name"),
        (&payload.version, "missing_rule_pack_version"),
        (&payload.jurisdiction, "missing_rule_pack_jurisdiction"),
        (&payload.source, "missing_rule_pack_source"),
    ] {
        if value.trim().is_empty() {
            return Err(ApiError::bad_request(
                code,
                "rule pack metadata is incomplete",
            ));
        }
    }
    if !matches!(
        normalize_jurisdiction(&payload.jurisdiction).as_str(),
        "EU" | "UK" | "US" | "NG"
    ) {
        return Err(ApiError::bad_request(
            "invalid_rule_pack_jurisdiction",
            "rule pack jurisdiction must be one of EU, UK, US, or NG",
        ));
    }
    Ok(())
}

fn enforce_activation_report(report: &Value, golden_case_count: i32) -> Result<(), ApiError> {
    let valid = report.get("valid").and_then(Value::as_bool) == Some(true);
    let wasm_safety_valid = report
        .get("wasm_safety")
        .and_then(|value| value.get("valid"))
        .and_then(Value::as_bool)
        == Some(true);
    let matrix_coverage_valid = report
        .get("matrix_coverage")
        .and_then(|value| value.get("valid"))
        .and_then(Value::as_bool)
        == Some(true);
    if !valid
        || golden_case_count < MIN_GOLDEN_CASES_FOR_ACTIVATION as i32
        || !wasm_safety_valid
        || !matrix_coverage_valid
    {
        return Err(ApiError::bad_request(
            "rule_pack_activation_blocked",
            "rule pack activation requires valid syntax, WASM safety, matrix coverage, and at least 10 golden cases",
        ));
    }
    Ok(())
}

fn require_admin(scope: crate::auth::UserScope) -> Result<(), ApiError> {
    if can_scope(scope, ResourceAction::RulePacksManage) {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "insufficient_scope",
            "API key scope cannot manage rule packs",
        ))
    }
}

fn normalize_jurisdiction(jurisdiction: &str) -> String {
    jurisdiction.trim().to_ascii_uppercase()
}

fn hash_source(source: &str) -> String {
    let digest = Sha256::digest(source.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

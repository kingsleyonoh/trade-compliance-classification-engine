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
    rules::{compiler::RulePackDocument, validator::validate_source},
};

mod activation;

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
    let (document, report) = validate_upload_source(&payload.source)?;
    let row = insert_rule_pack(&state, context.tenant_id, &payload, &document, &report).await?;
    Ok((
        axum::http::StatusCode::CREATED,
        Json(upload_response(row, report.as_json())),
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
        .ok_or_else(rule_pack_not_found)?;
    let (_, report) = validate_source(&row.get::<String, _>("source_yaml"))?;
    persist_validation_report(&state, context.tenant_id, id, &report).await?;
    Ok(Json(report.as_json()))
}

pub async fn activate_rule_pack(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    activation::handle(state, headers, id).await
}

fn validate_upload_source(
    source: &str,
) -> Result<(RulePackDocument, crate::rules::validator::ValidationReport), ApiError> {
    let (document, report) = validate_source(source)?;
    if report.valid {
        Ok((document, report))
    } else {
        Err(ApiError::bad_request(
            "rule_pack_validation_failed",
            report.errors.join(", "),
        ))
    }
}

async fn insert_rule_pack(
    state: &AppState,
    tenant_id: Uuid,
    payload: &UploadRulePackRequest,
    document: &RulePackDocument,
    report: &crate::rules::validator::ValidationReport,
) -> Result<sqlx::postgres::PgRow, ApiError> {
    sqlx::query("INSERT INTO rule_packs (tenant_id, name, version, jurisdiction, source_yaml, source_hash, compiled_wasm_sha256, golden_case_count, payload, validation_report, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft') RETURNING id, status::text AS status")
        .bind(tenant_id)
        .bind(payload.name.trim())
        .bind(payload.version.trim())
        .bind(normalize_jurisdiction(&payload.jurisdiction))
        .bind(&payload.source)
        .bind(hash_source(&payload.source))
        .bind(compiled_wasm_hash(document)?)
        .bind(report.golden_case_count as i32)
        .bind(serde_json::to_value(document).map_err(|_| serialization_error())?)
        .bind(report.as_json())
        .fetch_one(&state.pool)
        .await
        .map_err(ApiError::from_sqlx)
}

async fn persist_validation_report(
    state: &AppState,
    tenant_id: Uuid,
    id: Uuid,
    report: &crate::rules::validator::ValidationReport,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE rule_packs SET validation_report=$1, golden_case_count=$2 WHERE tenant_id=$3 AND id=$4")
        .bind(report.as_json())
        .bind(report.golden_case_count as i32)
        .bind(tenant_id)
        .bind(id)
        .execute(&state.pool)
        .await
        .map(|_| ())
        .map_err(ApiError::from_sqlx)
}

fn upload_response(row: sqlx::postgres::PgRow, report: Value) -> Value {
    json!({"id": row.get::<Uuid, _>("id"), "status": row.get::<String, _>("status"), "validation_report": report})
}

fn validate_metadata(payload: &UploadRulePackRequest) -> Result<(), ApiError> {
    for (value, code) in required_metadata(payload) {
        if value.trim().is_empty() {
            return Err(ApiError::bad_request(
                code,
                "rule pack metadata is incomplete",
            ));
        }
    }
    if matches!(
        normalize_jurisdiction(&payload.jurisdiction).as_str(),
        "EU" | "UK" | "US" | "NG"
    ) {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "invalid_rule_pack_jurisdiction",
            "rule pack jurisdiction must be one of EU, UK, US, or NG",
        ))
    }
}

fn required_metadata(payload: &UploadRulePackRequest) -> [(&str, &'static str); 4] {
    [
        (&payload.name, "missing_rule_pack_name"),
        (&payload.version, "missing_rule_pack_version"),
        (&payload.jurisdiction, "missing_rule_pack_jurisdiction"),
        (&payload.source, "missing_rule_pack_source"),
    ]
}

pub(super) fn require_admin(scope: crate::auth::UserScope) -> Result<(), ApiError> {
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

fn compiled_wasm_hash(document: &RulePackDocument) -> Result<String, ApiError> {
    serde_json::to_string(document)
        .map(|source| hash_source(&source))
        .map_err(|_| serialization_error())
}

fn hash_source(source: &str) -> String {
    let digest = Sha256::digest(source.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn serialization_error() -> ApiError {
    ApiError::bad_request("invalid_rule_pack", "rule pack cannot be serialized")
}

pub(super) fn rule_pack_not_found() -> ApiError {
    ApiError::not_found(
        "rule_pack_not_found",
        "rule pack was not found for this tenant",
    )
}

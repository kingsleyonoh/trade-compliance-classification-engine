use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::errors::ApiError;

pub(super) const SELECT: &str = "id, product_id, rule_pack_id, rule_pack_version, jurisdiction, status, input_snapshot, candidate_codes, selected_code, confidence::text AS confidence, risk_band, candidates, explanation, failure_reason, created_at::text AS created_at, updated_at::text AS updated_at";

pub(super) async fn fetch_one(
    pool: &PgPool,
    tenant_id: Uuid,
    id: Uuid,
) -> Result<sqlx::postgres::PgRow, ApiError> {
    sqlx::query(&format!(
        "SELECT {SELECT} FROM classification_runs WHERE tenant_id=$1 AND id=$2"
    ))
    .bind(tenant_id)
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::from_sqlx)?
    .ok_or_else(|| {
        ApiError::not_found(
            "classification_not_found",
            "classification run was not found for this tenant",
        )
    })
}

pub(super) fn product_snapshot(product: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": product.get::<Uuid, _>("id"),
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

pub(super) fn classification_json(row: sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "product_id": row.get::<Uuid, _>("product_id"),
        "rule_pack_id": row.try_get::<Uuid, _>("rule_pack_id").ok(),
        "rule_pack_version": row.try_get::<Option<String>, _>("rule_pack_version").ok().flatten(),
        "jurisdiction": row.get::<String, _>("jurisdiction"),
        "status": row.get::<String, _>("status"),
        "input_snapshot": row.get::<Value, _>("input_snapshot"),
        "candidate_codes": row.get::<Value, _>("candidate_codes"),
        "candidates": row.get::<Value, _>("candidates"),
        "selected_code": row.get::<Option<String>, _>("selected_code"),
        "confidence": row.get::<Option<String>, _>("confidence"),
        "risk_band": row.get::<Option<String>, _>("risk_band"),
        "explanation": row.get::<Value, _>("explanation"),
        "failure_reason": row.get::<Option<String>, _>("failure_reason"),
        "created_at": row.get::<String, _>("created_at"),
        "updated_at": row.get::<String, _>("updated_at")
    })
}

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, QueryBuilder, Row};
use uuid::Uuid;

use super::AppState;
use crate::{
    auth::{
        authenticate_api_key,
        policies::{can_scope, ResourceAction},
    },
    errors::ApiError,
};

#[derive(Debug, Deserialize)]
pub struct RunClassificationsRequest {
    pub product_ids: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct ListClassificationsQuery {
    pub cursor: Option<Uuid>,
    pub limit: Option<i64>,
    pub status: Option<String>,
}

pub async fn run_classifications(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RunClassificationsRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ClassificationsRun)?;
    if payload.product_ids.is_empty() {
        return Err(ApiError::bad_request(
            "missing_product_ids",
            "classification run requires at least one product id",
        ));
    }
    if payload.product_ids.len() > 100 {
        return Err(ApiError::bad_request(
            "too_many_products",
            "classification run supports at most 100 products per request",
        ));
    }

    let mut tx = state.pool.begin().await.map_err(ApiError::from_sqlx)?;
    let mut runs = Vec::with_capacity(payload.product_ids.len());
    for product_id in payload.product_ids {
        let product = sqlx::query("SELECT id, sku, name, description, country_of_origin, jurisdiction, product_type, materials, intended_use, readiness_status::text AS readiness_status, source_row FROM products WHERE tenant_id=$1 AND id=$2 AND status <> 'archived'")
            .bind(context.tenant_id)
            .bind(product_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::from_sqlx)?
            .ok_or_else(|| ApiError::not_found("product_not_found", "product was not found for this tenant"))?;
        if product.get::<String, _>("readiness_status") != "ready" {
            return Err(ApiError::bad_request(
                "product_not_ready",
                "only products with complete classification facts can be queued",
            ));
        }
        let jurisdiction = product.get::<String, _>("jurisdiction");
        let snapshot = product_snapshot(&product);
        let pack = sqlx::query("SELECT id, version FROM rule_packs WHERE tenant_id=$1 AND jurisdiction=$2 AND status='active' ORDER BY activated_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 1")
            .bind(context.tenant_id)
            .bind(&jurisdiction)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::from_sqlx)?;
        let Some(pack) = pack else {
            let blocked = sqlx::query("INSERT INTO classification_runs (tenant_id, product_id, jurisdiction, product_snapshot, input_snapshot, status, failure_reason, explanation, started_at, finished_at, updated_at) VALUES ($1,$2,$3,$4,$4,'blocked','no_active_rule_pack',$5,now(),now(),now()) RETURNING id, product_id, rule_pack_id, rule_pack_version, jurisdiction, status, input_snapshot, candidate_codes, selected_code, confidence::text AS confidence, risk_band, candidates, explanation, failure_reason, created_at::text AS created_at, updated_at::text AS updated_at")
                .bind(context.tenant_id)
                .bind(product_id)
                .bind(&jurisdiction)
                .bind(snapshot)
                .bind(json!({"blocked_reason":"no_active_rule_pack"}))
                .fetch_one(&mut *tx)
                .await
                .map_err(ApiError::from_sqlx)?;
            runs.push(classification_json(blocked));
            continue;
        };
        let rule_pack_id = pack.get::<Uuid, _>("id");
        let existing = sqlx::query("SELECT id, product_id, rule_pack_id, rule_pack_version, jurisdiction, status, input_snapshot, candidate_codes, selected_code, confidence::text AS confidence, risk_band, candidates, explanation, failure_reason, created_at::text AS created_at, updated_at::text AS updated_at FROM classification_runs WHERE tenant_id=$1 AND product_id=$2 AND rule_pack_id=$3 AND status IN ('queued','running','classified','needs_review','blocked') ORDER BY created_at DESC, id DESC LIMIT 1")
            .bind(context.tenant_id)
            .bind(product_id)
            .bind(rule_pack_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::from_sqlx)?;
        if let Some(existing) = existing {
            runs.push(classification_json(existing));
            continue;
        }
        let run = sqlx::query("INSERT INTO classification_runs (tenant_id, product_id, rule_pack_id, jurisdiction, product_snapshot, input_snapshot, rule_pack_version, status, started_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5,$6,'queued',now(),now()) RETURNING id, product_id, rule_pack_id, rule_pack_version, jurisdiction, status, input_snapshot, candidate_codes, selected_code, confidence::text AS confidence, risk_band, candidates, explanation, failure_reason, created_at::text AS created_at, updated_at::text AS updated_at")
            .bind(context.tenant_id)
            .bind(product_id)
            .bind(rule_pack_id)
            .bind(&jurisdiction)
            .bind(snapshot.clone())
            .bind(pack.get::<String, _>("version"))
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::from_sqlx)?;
        let run_id = run.get::<Uuid, _>("id");
        sqlx::query("INSERT INTO classification_jobs (tenant_id, product_id, classification_run_id, status, payload, priority) VALUES ($1,$2,$3,'queued',$4,0)")
            .bind(context.tenant_id)
            .bind(product_id)
            .bind(run_id)
            .bind(json!({
                "classification_run_id": run_id,
                "product_id": product_id,
                "rule_pack_id": rule_pack_id,
                "jurisdiction": jurisdiction,
                "input_snapshot": snapshot
            }))
            .execute(&mut *tx)
            .await
            .map_err(ApiError::from_sqlx)?;
        runs.push(classification_json(run));
    }
    tx.commit().await.map_err(ApiError::from_sqlx)?;
    Ok((StatusCode::CREATED, Json(json!({ "runs": runs }))))
}

pub async fn list_classifications(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListClassificationsQuery>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ClassificationsRead)?;
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let mut builder: QueryBuilder<Postgres> = QueryBuilder::new("SELECT id, product_id, rule_pack_id, rule_pack_version, jurisdiction, status, input_snapshot, candidate_codes, selected_code, confidence::text AS confidence, risk_band, candidates, explanation, failure_reason, created_at::text AS created_at, updated_at::text AS updated_at FROM classification_runs WHERE tenant_id = ");
    builder.push_bind(context.tenant_id);
    if let Some(status) = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        builder.push(" AND status = ");
        builder.push_bind(status);
    }
    if let Some(cursor) = query.cursor {
        builder.push(" AND id > ");
        builder.push_bind(cursor);
    }
    builder.push(" ORDER BY id ASC LIMIT ");
    builder.push_bind(limit + 1);
    let rows = builder
        .build()
        .fetch_all(&state.pool)
        .await
        .map_err(ApiError::from_sqlx)?;
    let has_more = rows.len() as i64 > limit;
    let items = rows
        .into_iter()
        .take(limit as usize)
        .map(classification_json)
        .collect::<Vec<_>>();
    let next_cursor = if has_more {
        items
            .last()
            .and_then(|item| item["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    Ok(Json(json!({ "items": items, "next_cursor": next_cursor })))
}

pub async fn get_classification(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ClassificationsRead)?;
    let row = sqlx::query("SELECT id, product_id, rule_pack_id, rule_pack_version, jurisdiction, status, input_snapshot, candidate_codes, selected_code, confidence::text AS confidence, risk_band, candidates, explanation, failure_reason, created_at::text AS created_at, updated_at::text AS updated_at FROM classification_runs WHERE tenant_id=$1 AND id=$2")
        .bind(context.tenant_id)
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(ApiError::from_sqlx)?
        .ok_or_else(|| ApiError::not_found("classification_not_found", "classification run was not found for this tenant"))?;
    Ok(Json(classification_json(row)))
}

fn product_snapshot(product: &sqlx::postgres::PgRow) -> Value {
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

fn classification_json(row: sqlx::postgres::PgRow) -> Value {
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

fn require_scope(scope: crate::auth::UserScope, action: ResourceAction) -> Result<(), ApiError> {
    if can_scope(scope, action) {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "insufficient_scope",
            "API key scope cannot perform this classification action",
        ))
    }
}

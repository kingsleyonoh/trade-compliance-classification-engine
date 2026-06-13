use axum::{http::HeaderMap, http::StatusCode, Json};
use serde_json::{json, Value};
use sqlx::{Postgres, Row};
use uuid::Uuid;

use super::{require_scope, rows, AppState, ResourceAction, RunClassificationsRequest};
use crate::{
    auth::{authenticate_api_key, TenantContext},
    errors::ApiError,
};

pub(super) async fn handle(
    state: AppState,
    headers: HeaderMap,
    payload: RunClassificationsRequest,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ClassificationsRun)?;
    validate_run_request(&payload)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::from_sqlx)?;
    let mut runs = Vec::with_capacity(payload.product_ids.len());
    for product_id in payload.product_ids {
        runs.push(queue_product_classification(&mut tx, &context, product_id).await?);
    }
    tx.commit().await.map_err(ApiError::from_sqlx)?;
    Ok((StatusCode::CREATED, Json(json!({ "runs": runs }))))
}

async fn queue_product_classification(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    context: &TenantContext,
    product_id: Uuid,
) -> Result<Value, ApiError> {
    let product = fetch_ready_product(tx, context.tenant_id, product_id).await?;
    let jurisdiction = product.get::<String, _>("jurisdiction");
    let snapshot = rows::product_snapshot(&product);
    let Some(pack) = fetch_active_pack(tx, context.tenant_id, &jurisdiction).await? else {
        return insert_blocked_run(tx, context.tenant_id, product_id, &jurisdiction, snapshot)
            .await;
    };
    if let Some(existing) = fetch_existing_run(tx, context.tenant_id, product_id, &pack).await? {
        return Ok(rows::classification_json(existing));
    }
    insert_queued_run(
        tx,
        context.tenant_id,
        product_id,
        &jurisdiction,
        snapshot,
        pack,
    )
    .await
}

async fn fetch_ready_product(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    tenant_id: Uuid,
    product_id: Uuid,
) -> Result<sqlx::postgres::PgRow, ApiError> {
    let product = sqlx::query("SELECT id, sku, name, description, country_of_origin, jurisdiction, product_type, materials, intended_use, readiness_status::text AS readiness_status, source_row FROM products WHERE tenant_id=$1 AND id=$2 AND status <> 'archived'")
        .bind(tenant_id)
        .bind(product_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(ApiError::from_sqlx)?
        .ok_or_else(|| ApiError::not_found("product_not_found", "product was not found for this tenant"))?;
    ensure_product_ready(&product)?;
    Ok(product)
}

async fn fetch_active_pack(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    tenant_id: Uuid,
    jurisdiction: &str,
) -> Result<Option<sqlx::postgres::PgRow>, ApiError> {
    sqlx::query("SELECT id, version FROM rule_packs WHERE tenant_id=$1 AND jurisdiction=$2 AND status='active' ORDER BY activated_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 1")
        .bind(tenant_id)
        .bind(jurisdiction)
        .fetch_optional(&mut **tx)
        .await
        .map_err(ApiError::from_sqlx)
}

async fn fetch_existing_run(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    tenant_id: Uuid,
    product_id: Uuid,
    pack: &sqlx::postgres::PgRow,
) -> Result<Option<sqlx::postgres::PgRow>, ApiError> {
    sqlx::query(&format!("SELECT {} FROM classification_runs WHERE tenant_id=$1 AND product_id=$2 AND rule_pack_id=$3 AND status IN ('queued','running','classified','needs_review','blocked') ORDER BY created_at DESC, id DESC LIMIT 1", rows::SELECT))
        .bind(tenant_id)
        .bind(product_id)
        .bind(pack.get::<Uuid, _>("id"))
        .fetch_optional(&mut **tx)
        .await
        .map_err(ApiError::from_sqlx)
}

async fn insert_blocked_run(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    tenant_id: Uuid,
    product_id: Uuid,
    jurisdiction: &str,
    snapshot: Value,
) -> Result<Value, ApiError> {
    let blocked = sqlx::query(&format!("INSERT INTO classification_runs (tenant_id, product_id, jurisdiction, product_snapshot, input_snapshot, status, failure_reason, explanation, started_at, finished_at, updated_at) VALUES ($1,$2,$3,$4,$4,'blocked','no_active_rule_pack',$5,now(),now(),now()) RETURNING {}", rows::SELECT))
        .bind(tenant_id)
        .bind(product_id)
        .bind(jurisdiction)
        .bind(snapshot)
        .bind(json!({"blocked_reason":"no_active_rule_pack"}))
        .fetch_one(&mut **tx)
        .await
        .map_err(ApiError::from_sqlx)?;
    Ok(rows::classification_json(blocked))
}

async fn insert_queued_run(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    tenant_id: Uuid,
    product_id: Uuid,
    jurisdiction: &str,
    snapshot: Value,
    pack: sqlx::postgres::PgRow,
) -> Result<Value, ApiError> {
    let run = insert_run_row(
        tx,
        tenant_id,
        product_id,
        jurisdiction,
        snapshot.clone(),
        &pack,
    )
    .await?;
    let run_id = run.get::<Uuid, _>("id");
    insert_classification_job(tx, tenant_id, product_id, run_id, pack, snapshot).await?;
    Ok(rows::classification_json(run))
}

async fn insert_run_row(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    tenant_id: Uuid,
    product_id: Uuid,
    jurisdiction: &str,
    snapshot: Value,
    pack: &sqlx::postgres::PgRow,
) -> Result<sqlx::postgres::PgRow, ApiError> {
    sqlx::query(&format!("INSERT INTO classification_runs (tenant_id, product_id, rule_pack_id, jurisdiction, product_snapshot, input_snapshot, rule_pack_version, status, started_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5,$6,'queued',now(),now()) RETURNING {}", rows::SELECT))
        .bind(tenant_id)
        .bind(product_id)
        .bind(pack.get::<Uuid, _>("id"))
        .bind(jurisdiction)
        .bind(snapshot)
        .bind(pack.get::<String, _>("version"))
        .fetch_one(&mut **tx)
        .await
        .map_err(ApiError::from_sqlx)
}

async fn insert_classification_job(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    tenant_id: Uuid,
    product_id: Uuid,
    run_id: Uuid,
    pack: sqlx::postgres::PgRow,
    snapshot: Value,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO classification_jobs (tenant_id, product_id, classification_run_id, status, payload, priority) VALUES ($1,$2,$3,'queued',$4,0)")
        .bind(tenant_id)
        .bind(product_id)
        .bind(run_id)
        .bind(job_payload(run_id, product_id, pack, snapshot))
        .execute(&mut **tx)
        .await
        .map(|_| ())
        .map_err(ApiError::from_sqlx)
}

fn job_payload(
    run_id: Uuid,
    product_id: Uuid,
    pack: sqlx::postgres::PgRow,
    snapshot: Value,
) -> Value {
    json!({
        "classification_run_id": run_id,
        "product_id": product_id,
        "rule_pack_id": pack.get::<Uuid, _>("id"),
        "jurisdiction": snapshot["jurisdiction"],
        "input_snapshot": snapshot
    })
}

fn ensure_product_ready(product: &sqlx::postgres::PgRow) -> Result<(), ApiError> {
    if product.get::<String, _>("readiness_status") == "ready" {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "product_not_ready",
            "only products with complete classification facts can be queued",
        ))
    }
}

fn validate_run_request(payload: &RunClassificationsRequest) -> Result<(), ApiError> {
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
    Ok(())
}

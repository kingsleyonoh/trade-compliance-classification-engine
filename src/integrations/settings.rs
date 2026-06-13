use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::errors::ApiError;

pub async fn upsert_integration_setting(
    pool: &PgPool,
    tenant_id: Uuid,
    provider: &str,
    enabled: bool,
    config: Value,
    secret_ref: Option<&str>,
) -> Result<Value, ApiError> {
    let row = sqlx::query("INSERT INTO integration_settings (tenant_id, provider, enabled, config, secret_ref, last_status, updated_at) VALUES ($1,$2,$3,$4,$5,'unknown',now()) ON CONFLICT (tenant_id, provider) DO UPDATE SET enabled=EXCLUDED.enabled, config=EXCLUDED.config, secret_ref=EXCLUDED.secret_ref, updated_at=now() RETURNING id, tenant_id, provider, enabled, config, secret_ref, last_checked_at::text AS last_checked_at, last_status, created_at::text AS created_at, updated_at::text AS updated_at")
        .bind(tenant_id)
        .bind(provider)
        .bind(enabled)
        .bind(config)
        .bind(secret_ref)
        .fetch_one(pool)
        .await
        .map_err(ApiError::from_sqlx)?;
    Ok(setting_json(row))
}

pub async fn list_integration_settings(
    pool: &PgPool,
    tenant_id: Uuid,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query("SELECT id, tenant_id, provider, enabled, config, secret_ref, last_checked_at::text AS last_checked_at, last_status, created_at::text AS created_at, updated_at::text AS updated_at FROM integration_settings WHERE tenant_id=$1 ORDER BY provider")
        .bind(tenant_id)
        .fetch_all(pool)
        .await
        .map_err(ApiError::from_sqlx)?;
    Ok(rows.into_iter().map(setting_json).collect())
}

fn setting_json(row: sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "tenant_id": row.get::<Uuid, _>("tenant_id"),
        "provider": row.get::<String, _>("provider"),
        "enabled": row.get::<bool, _>("enabled"),
        "config": row.get::<Value, _>("config"),
        "secret_ref": row.get::<Option<String>, _>("secret_ref"),
        "last_checked_at": row.get::<Option<String>, _>("last_checked_at"),
        "last_status": row.get::<Option<String>, _>("last_status"),
        "created_at": row.get::<String, _>("created_at"),
        "updated_at": row.get::<String, _>("updated_at")
    })
}

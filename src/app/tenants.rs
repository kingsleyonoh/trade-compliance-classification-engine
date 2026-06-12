use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use super::AppState;
use crate::{
    auth::{authenticate_api_key, TenantContext},
    errors::ApiError,
};

mod validation;

use validation::{registration_rate_limit_key, slugify, validate_registration};

#[derive(Debug, Deserialize)]
pub struct RegisterTenantRequest {
    pub legal_name: String,
    pub full_legal_name: String,
    pub display_name: String,
    #[serde(default)]
    pub address: Value,
    #[serde(default)]
    pub registration: Value,
    #[serde(default)]
    pub contact: Value,
    pub wordmark: String,
    #[serde(default)]
    pub regulator_ids: Value,
    pub admin_email: String,
}

#[derive(Debug, Serialize)]
pub struct RegisterTenantResponse {
    pub tenant_id: Uuid,
    pub user_id: Uuid,
    pub api_key: String,
}

struct RegistrationRecord {
    tenant_id: Uuid,
    user_id: Uuid,
    api_key: String,
    key_hash: String,
    key_prefix: String,
    slug: String,
}

pub async fn register(
    State(state): State<AppState>,
    _headers: HeaderMap,
    Json(payload): Json<RegisterTenantRequest>,
) -> Result<(StatusCode, Json<RegisterTenantResponse>), ApiError> {
    if !state.self_registration_enabled {
        return Err(ApiError::forbidden(
            "registration_disabled",
            "self registration is disabled",
        ));
    }
    validate_registration(&payload)?;
    state
        .registration_limiter
        .check(&registration_rate_limit_key(&payload.admin_email))?;
    let record = registration_record(&payload, &state.api_key_pepper);
    insert_registration(&state, &payload, &record).await?;
    Ok((StatusCode::CREATED, Json(register_response(record))))
}

pub async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    tenant_me(&state, context).await
}

async fn tenant_me(state: &AppState, context: TenantContext) -> Result<Json<Value>, ApiError> {
    let row = sqlx::query("SELECT t.id AS tenant_id, t.legal_name, t.full_legal_name, t.display_name, t.address, t.registration, t.contact, t.wordmark, t.regulator_ids, u.id AS user_id, u.email, u.scope::text AS scope FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE t.id = $1 AND u.id = $2 AND t.is_active = true AND u.is_active = true")
        .bind(context.tenant_id)
        .bind(context.user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(ApiError::from_sqlx)?
        .ok_or_else(|| ApiError::unauthorized("invalid_api_key", "API key identity is no longer valid"))?;
    Ok(Json(tenant_identity(row)))
}

fn registration_record(payload: &RegisterTenantRequest, pepper: &str) -> RegistrationRecord {
    let tenant_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    let api_key = format!("tcce_{}_{}", tenant_id.simple(), Uuid::new_v4().simple());
    let key_hash = crate::auth::hash_api_key(&api_key, pepper);
    let key_prefix = api_key.chars().take(12).collect::<String>();
    let slug = slugify(&payload.display_name, tenant_id);
    RegistrationRecord {
        tenant_id,
        user_id,
        api_key,
        key_hash,
        key_prefix,
        slug,
    }
}

async fn insert_registration(
    state: &AppState,
    payload: &RegisterTenantRequest,
    record: &RegistrationRecord,
) -> Result<(), ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::from_sqlx)?;
    insert_tenant(&mut tx, payload, record).await?;
    insert_user(&mut tx, payload, record).await?;
    insert_api_key(&mut tx, record).await?;
    tx.commit().await.map_err(ApiError::from_sqlx)
}

async fn insert_tenant(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    payload: &RegisterTenantRequest,
    record: &RegistrationRecord,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO tenants (id, slug, legal_name, full_legal_name, display_name, address, registration, contact, wordmark, regulator_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(record.tenant_id)
        .bind(&record.slug)
        .bind(payload.legal_name.trim())
        .bind(payload.full_legal_name.trim())
        .bind(payload.display_name.trim())
        .bind(&payload.address)
        .bind(&payload.registration)
        .bind(&payload.contact)
        .bind(payload.wordmark.trim())
        .bind(&payload.regulator_ids)
        .execute(&mut **tx)
        .await
        .map(|_| ())
        .map_err(ApiError::from_sqlx)
}

async fn insert_user(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    payload: &RegisterTenantRequest,
    record: &RegistrationRecord,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO users (id, tenant_id, email, scope) VALUES ($1,$2,$3,'admin')")
        .bind(record.user_id)
        .bind(record.tenant_id)
        .bind(payload.admin_email.trim())
        .execute(&mut **tx)
        .await
        .map(|_| ())
        .map_err(ApiError::from_sqlx)
}

async fn insert_api_key(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    record: &RegistrationRecord,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO api_keys (tenant_id, user_id, key_hash, key_prefix) VALUES ($1,$2,$3,$4)",
    )
    .bind(record.tenant_id)
    .bind(record.user_id)
    .bind(&record.key_hash)
    .bind(&record.key_prefix)
    .execute(&mut **tx)
    .await
    .map(|_| ())
    .map_err(ApiError::from_sqlx)
}

fn tenant_identity(row: sqlx::postgres::PgRow) -> Value {
    json!({
        "tenant": {
            "id": row.get::<Uuid, _>("tenant_id"),
            "legal_name": row.get::<String, _>("legal_name"),
            "full_legal_name": row.get::<String, _>("full_legal_name"),
            "display_name": row.get::<String, _>("display_name"),
            "address": row.get::<Value, _>("address"),
            "registration": row.get::<Value, _>("registration"),
            "contact": row.get::<Value, _>("contact"),
            "wordmark": row.get::<String, _>("wordmark"),
            "regulator_ids": row.get::<Value, _>("regulator_ids")
        },
        "user": {
            "id": row.get::<Uuid, _>("user_id"),
            "email": row.get::<String, _>("email"),
            "scope": row.get::<String, _>("scope")
        }
    })
}

fn register_response(record: RegistrationRecord) -> RegisterTenantResponse {
    RegisterTenantResponse {
        tenant_id: record.tenant_id,
        user_id: record.user_id,
        api_key: record.api_key,
    }
}

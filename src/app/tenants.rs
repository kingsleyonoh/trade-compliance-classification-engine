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
    auth::{authenticate_api_key, TenantContext, UserScope},
    errors::ApiError,
};

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

    let tenant_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    let slug = slugify(&payload.display_name, tenant_id);
    let api_key = format!("tcce_{}_{}", tenant_id.simple(), Uuid::new_v4().simple());
    let key_hash = crate::auth::hash_api_key(&api_key, &state.api_key_pepper);
    let key_prefix = api_key.chars().take(12).collect::<String>();

    let mut tx = state.pool.begin().await.map_err(ApiError::from_sqlx)?;
    sqlx::query("INSERT INTO tenants (id, slug, legal_name, full_legal_name, display_name, address, registration, contact, wordmark, regulator_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(tenant_id)
        .bind(&slug)
        .bind(payload.legal_name.trim())
        .bind(payload.full_legal_name.trim())
        .bind(payload.display_name.trim())
        .bind(&payload.address)
        .bind(&payload.registration)
        .bind(&payload.contact)
        .bind(payload.wordmark.trim())
        .bind(&payload.regulator_ids)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::from_sqlx)?;
    sqlx::query("INSERT INTO users (id, tenant_id, email, scope) VALUES ($1,$2,$3,'admin')")
        .bind(user_id)
        .bind(tenant_id)
        .bind(payload.admin_email.trim())
        .execute(&mut *tx)
        .await
        .map_err(ApiError::from_sqlx)?;
    sqlx::query(
        "INSERT INTO api_keys (tenant_id, user_id, key_hash, key_prefix) VALUES ($1,$2,$3,$4)",
    )
    .bind(tenant_id)
    .bind(user_id)
    .bind(key_hash)
    .bind(key_prefix)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::from_sqlx)?;
    tx.commit().await.map_err(ApiError::from_sqlx)?;

    Ok((
        StatusCode::CREATED,
        Json(RegisterTenantResponse {
            tenant_id,
            user_id,
            api_key,
        }),
    ))
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

    Ok(Json(json!({
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
    })))
}

fn validate_registration(payload: &RegisterTenantRequest) -> Result<(), ApiError> {
    if payload.legal_name.trim().is_empty() {
        return Err(ApiError::bad_request(
            "missing_legal_name",
            "legal_name is required",
        ));
    }
    if payload.full_legal_name.trim().is_empty() {
        return Err(ApiError::bad_request(
            "missing_full_legal_name",
            "full_legal_name is required",
        ));
    }
    if payload.display_name.trim().is_empty() {
        return Err(ApiError::bad_request(
            "missing_display_name",
            "display_name is required",
        ));
    }
    require_non_empty_object(&payload.address, "missing_address", "address is required")?;
    require_non_empty_object(
        &payload.registration,
        "missing_registration",
        "registration is required",
    )?;
    require_non_empty_object(&payload.contact, "missing_contact", "contact is required")?;
    if payload.wordmark.trim().is_empty() {
        return Err(ApiError::bad_request(
            "missing_wordmark",
            "wordmark is required",
        ));
    }
    if !payload.regulator_ids.is_object() {
        return Err(ApiError::bad_request(
            "invalid_regulator_ids",
            "regulator_ids must be an object",
        ));
    }
    let admin_email = normalize_email(&payload.admin_email)?;
    let contact_email = payload
        .contact
        .get("email")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ApiError::bad_request("missing_contact_email", "contact.email is required")
        })?;
    if normalize_email(contact_email)? != admin_email {
        return Err(ApiError::bad_request(
            "invalid_contact_email",
            "contact.email must match admin_email",
        ));
    }
    Ok(())
}

fn require_non_empty_object(
    value: &Value,
    code: &'static str,
    message: &'static str,
) -> Result<(), ApiError> {
    match value.as_object() {
        Some(object) if !object.is_empty() => Ok(()),
        _ => Err(ApiError::bad_request(code, message)),
    }
}

fn normalize_email(email: &str) -> Result<String, ApiError> {
    let trimmed = email.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request(
            "missing_admin_email",
            "admin_email is required",
        ));
    }
    if !trimmed.contains('@') {
        return Err(ApiError::bad_request(
            "invalid_admin_email",
            "admin_email must be an email address",
        ));
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn registration_rate_limit_key(admin_email: &str) -> String {
    format!("admin_email:{}", admin_email.trim().to_ascii_lowercase())
}

fn slugify(display_name: &str, tenant_id: Uuid) -> String {
    let slug = display_name
        .chars()
        .filter_map(|ch| {
            if ch.is_ascii_alphanumeric() {
                Some(ch.to_ascii_lowercase())
            } else if ch.is_whitespace() || ch == '-' || ch == '_' {
                Some('-')
            } else {
                None
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let base = if slug.is_empty() {
        "tenant".to_string()
    } else {
        slug
    };
    format!("{}-{}", base, &tenant_id.to_string()[..8])
}

#[allow(dead_code)]
fn _scope_to_str(scope: UserScope) -> &'static str {
    match scope {
        UserScope::Admin => "admin",
        UserScope::Classifier => "classifier",
        UserScope::Reviewer => "reviewer",
        UserScope::Auditor => "auditor",
    }
}

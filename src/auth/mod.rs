use std::str::FromStr;

use axum::http::HeaderMap;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::errors::ApiError;

pub mod policies;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UserScope {
    Admin,
    Classifier,
    Reviewer,
    Auditor,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TenantContext {
    pub tenant_id: Uuid,
    pub user_id: Uuid,
    pub scope: UserScope,
}

impl TenantContext {
    pub fn from_headers(headers: &HeaderMap) -> Result<Self, ApiError> {
        Ok(Self {
            tenant_id: parse_uuid_header(headers, "x-tenant-id", "missing_tenant")?,
            user_id: parse_uuid_header(headers, "x-user-id", "missing_user")?,
            scope: parse_scope_header(headers)?,
        })
    }
}

pub async fn authenticate_api_key(
    pool: &PgPool,
    headers: &HeaderMap,
    api_key_pepper: &str,
) -> Result<TenantContext, ApiError> {
    let key = headers
        .get("x-api-key")
        .ok_or_else(|| {
            ApiError::unauthorized("missing_api_key", "required header x-api-key is missing")
        })?
        .to_str()
        .map_err(|_| {
            ApiError::unauthorized("invalid_api_key", "required header x-api-key is invalid")
        })?;
    let key_hash = hash_api_key(key, api_key_pepper);
    let row = sqlx::query("SELECT k.tenant_id, k.user_id, u.scope::text AS scope FROM api_keys k JOIN users u ON u.id = k.user_id AND u.tenant_id = k.tenant_id JOIN tenants t ON t.id = k.tenant_id WHERE k.key_hash = $1 AND t.is_active = true AND u.is_active = true")
        .bind(&key_hash)
        .fetch_optional(pool)
        .await
        .map_err(ApiError::from_sqlx)?
        .ok_or_else(|| ApiError::unauthorized("invalid_api_key", "API key is not recognized"))?;
    sqlx::query("UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1")
        .bind(&key_hash)
        .execute(pool)
        .await
        .map_err(ApiError::from_sqlx)?;
    Ok(TenantContext {
        tenant_id: row.get("tenant_id"),
        user_id: row.get("user_id"),
        scope: row.get::<String, _>("scope").parse()?,
    })
}

pub fn hash_api_key(key: &str, api_key_pepper: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"tcce-api-key-v2");
    hasher.update(api_key_pepper.as_bytes());
    hasher.update([0]);
    hasher.update(key.as_bytes());
    let digest = hasher.finalize();
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("tcce-key-v2:{hex}")
}

impl FromStr for UserScope {
    type Err = ApiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "admin" => Ok(Self::Admin),
            "classifier" => Ok(Self::Classifier),
            "reviewer" => Ok(Self::Reviewer),
            "auditor" => Ok(Self::Auditor),
            _ => Err(ApiError::unauthorized(
                "invalid_scope",
                "user scope is not recognized",
            )),
        }
    }
}

fn parse_uuid_header(
    headers: &HeaderMap,
    name: &'static str,
    code: &'static str,
) -> Result<Uuid, ApiError> {
    let value = headers
        .get(name)
        .ok_or_else(|| ApiError::unauthorized(code, format!("required header {name} is missing")))?
        .to_str()
        .map_err(|_| ApiError::unauthorized(code, format!("required header {name} is invalid")))?;

    Uuid::parse_str(value)
        .map_err(|_| ApiError::unauthorized(code, format!("required header {name} is invalid")))
}

fn parse_scope_header(headers: &HeaderMap) -> Result<UserScope, ApiError> {
    headers
        .get("x-user-scope")
        .ok_or_else(|| {
            ApiError::unauthorized("missing_scope", "required header x-user-scope is missing")
        })?
        .to_str()
        .map_err(|_| {
            ApiError::unauthorized("invalid_scope", "required header x-user-scope is invalid")
        })?
        .parse()
}

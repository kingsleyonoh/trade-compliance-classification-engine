use std::str::FromStr;

use axum::http::HeaderMap;
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

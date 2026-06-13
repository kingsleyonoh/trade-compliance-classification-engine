use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use super::AppState;
use crate::{
    auth::{
        authenticate_api_key,
        policies::{can_scope, ResourceAction},
    },
    errors::ApiError,
    outputs::{self, ExportFormat},
};

#[derive(Debug, Deserialize)]
pub struct CreateAuditExportRequest {
    pub classification_run_id: Uuid,
    pub format: String,
}

pub async fn create_audit_export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateAuditExportRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ExportsCreate)?;
    let format = ExportFormat::parse(&payload.format)?;
    let export = outputs::create_audit_export(
        &state.pool,
        context.tenant_id,
        payload.classification_run_id,
        format,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(export)))
}

pub async fn download_audit_export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<String, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ExportsCreate)?;
    outputs::download_audit_export(&state.pool, context.tenant_id, id).await
}

fn require_scope(scope: crate::auth::UserScope, action: ResourceAction) -> Result<(), ApiError> {
    if can_scope(scope, action) {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "insufficient_scope",
            "API key scope cannot perform this audit export action",
        ))
    }
}

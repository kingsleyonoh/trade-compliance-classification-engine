use axum::{
    extract::{Path, Query, State},
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
    reviews::{create_reviewer_override, OverrideRequest},
};

mod listing;
mod queue;
mod rows;

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
    queue::handle(state, headers, payload).await
}

pub async fn list_classifications(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListClassificationsQuery>,
) -> Result<Json<Value>, ApiError> {
    listing::handle(state, headers, query).await
}

pub async fn get_classification(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ClassificationsRead)?;
    let row = rows::fetch_one(&state.pool, context.tenant_id, id).await?;
    Ok(Json(rows::classification_json(row)))
}

pub async fn create_override(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(payload): Json<OverrideRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::OverridesCreate)?;
    let created = create_reviewer_override(&state.pool, &context, id, payload).await?;
    Ok((StatusCode::CREATED, Json(created)))
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

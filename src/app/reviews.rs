use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::Value;

use super::AppState;
use crate::{
    auth::{
        authenticate_api_key,
        policies::{can_scope, ResourceAction},
    },
    errors::ApiError,
    reviews as review_data,
};

#[derive(Debug, Deserialize)]
pub struct ReviewQueueQuery {
    pub limit: Option<i64>,
}

pub async fn review_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReviewQueueQuery>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ClassificationsRead)?;
    Ok(Json(
        review_data::review_queue(&state.pool, context.tenant_id, query.limit.unwrap_or(50))
            .await?,
    ))
}

fn require_scope(scope: crate::auth::UserScope, action: ResourceAction) -> Result<(), ApiError> {
    if can_scope(scope, action) {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "insufficient_scope",
            "API key scope cannot perform this review action",
        ))
    }
}

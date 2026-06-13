use axum::{extract::State, http::HeaderMap, http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

use super::AppState;
use crate::{
    auth::{authenticate_api_key, UserScope},
    errors::ApiError,
};

pub async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

pub async fn health_db(State(state): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    db_ok(&state).await?;
    Ok(Json(json!({ "status": "ok" })))
}

pub async fn health_ready(State(state): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    db_ok(&state).await?;
    Ok(Json(json!({ "status": "ok" })))
}

pub async fn metrics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(StatusCode, String), ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    if context.scope != UserScope::Admin {
        return Err(ApiError::forbidden(
            "insufficient_scope",
            "API key scope cannot read metrics",
        ));
    }
    Ok((StatusCode::OK, state.metrics.render_prometheus()))
}

async fn db_ok(state: &AppState) -> Result<(), ApiError> {
    sqlx::query("SELECT 1")
        .execute(&state.pool)
        .await
        .map_err(|_| {
            ApiError::service_unavailable("database_unavailable", "database health check failed")
        })?;
    Ok(())
}

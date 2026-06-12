use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::AppState;
use crate::{
    auth::{
        authenticate_api_key,
        policies::{can_scope, ResourceAction},
    },
    errors::ApiError,
};

mod import;
mod listing;
mod response;

#[derive(Debug, Deserialize)]
pub struct ImportProductsRequest {
    pub rows: Vec<ProductInput>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ProductInput {
    pub sku: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub country_of_origin: Option<String>,
    pub jurisdiction: Option<String>,
    pub product_type: Option<String>,
    #[serde(default)]
    pub materials: Vec<String>,
    pub intended_use: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub cursor: Option<String>,
    pub limit: Option<i64>,
    pub query: Option<String>,
}

pub async fn import_products(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ImportProductsRequest>,
) -> Result<Json<Value>, ApiError> {
    import::handle(state, headers, payload).await
}

pub async fn list_products(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    listing::handle(state, headers, query).await
}

pub async fn get_product(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ProductsRead)?;
    let row = sqlx::query("SELECT id, sku, name, description, country_of_origin, jurisdiction, product_type, materials, intended_use, readiness_status::text AS readiness_status, source_row, created_at::text AS created_at FROM products WHERE tenant_id = $1 AND id = $2")
        .bind(context.tenant_id)
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(ApiError::from_sqlx)?
        .ok_or_else(|| ApiError::not_found("product_not_found", "product was not found for this tenant"))?;
    Ok(Json(response::product_detail(row)))
}

fn require_scope(scope: crate::auth::UserScope, action: ResourceAction) -> Result<(), ApiError> {
    if can_scope(scope, action) {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "insufficient_scope",
            "API key scope cannot perform this action",
        ))
    }
}

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Postgres, QueryBuilder, Row};
use uuid::Uuid;

use super::AppState;
use crate::{
    auth::{
        authenticate_api_key,
        policies::{can_scope, ResourceAction},
    },
    errors::ApiError,
};

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
}

pub async fn import_products(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ImportProductsRequest>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ProductsWrite)?;
    let mut imported = 0_i64;
    let mut errors = Vec::new();

    for (index, row) in payload.rows.iter().enumerate() {
        match validate_product(index + 1, row) {
            Ok(ready) => {
                let materials = json!(row.materials);
                let source_row = serde_json::to_value(row).map_err(|_| {
                    ApiError::bad_request("invalid_product", "product row cannot be serialized")
                })?;
                sqlx::query("INSERT INTO products (tenant_id, sku, name, description, country_of_origin, jurisdiction, product_type, materials, intended_use, readiness_status, source_row) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::product_readiness_status,$11) ON CONFLICT (tenant_id, sku) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, country_of_origin = EXCLUDED.country_of_origin, jurisdiction = EXCLUDED.jurisdiction, product_type = EXCLUDED.product_type, materials = EXCLUDED.materials, intended_use = EXCLUDED.intended_use, readiness_status = EXCLUDED.readiness_status, source_row = EXCLUDED.source_row, updated_at = now()")
                    .bind(context.tenant_id)
                    .bind(row.sku.as_ref().unwrap().trim())
                    .bind(row.name.as_ref().map(|s| s.trim()).unwrap_or(""))
                    .bind(row.description.as_ref().unwrap().trim())
                    .bind(row.country_of_origin.as_ref().unwrap().trim())
                    .bind(row.jurisdiction.as_ref().unwrap().trim())
                    .bind(row.product_type.as_deref())
                    .bind(materials)
                    .bind(row.intended_use.as_deref())
                    .bind(ready)
                    .bind(source_row)
                    .execute(&state.pool)
                    .await
                    .map_err(ApiError::from_sqlx)?;
                imported += 1;
                state.metrics.increment_imports_started(context.tenant_id);
            }
            Err(error) => errors.push(error),
        }
    }

    Ok(Json(json!({ "imported": imported, "errors": errors })))
}

pub async fn list_products(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ProductsRead)?;
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let cursor = match query.cursor.as_deref() {
        Some(value) if !value.trim().is_empty() => {
            Some(Uuid::parse_str(value).map_err(|_| {
                ApiError::bad_request("invalid_cursor", "cursor must be a product id")
            })?)
        }
        _ => None,
    };

    let mut builder: QueryBuilder<Postgres> = QueryBuilder::new("SELECT id, sku, name, description, country_of_origin, jurisdiction, readiness_status::text AS readiness_status, created_at::text AS created_at FROM products WHERE tenant_id = ");
    builder.push_bind(context.tenant_id);
    if let Some(cursor) = cursor {
        builder.push(" AND id > ");
        builder.push_bind(cursor);
    }
    builder.push(" ORDER BY id ASC LIMIT ");
    builder.push_bind(limit + 1);

    let rows = builder
        .build()
        .fetch_all(&state.pool)
        .await
        .map_err(ApiError::from_sqlx)?;
    let has_more = rows.len() as i64 > limit;
    let items: Vec<Value> = rows
        .into_iter()
        .take(limit as usize)
        .map(product_summary)
        .collect();
    let next_cursor = if has_more {
        items
            .last()
            .and_then(|item| item["id"].as_str())
            .map(str::to_string)
    } else {
        None
    };

    Ok(Json(json!({ "items": items, "next_cursor": next_cursor })))
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
    Ok(Json(product_detail(row)))
}

fn validate_product(row_number: usize, row: &ProductInput) -> Result<&'static str, Value> {
    for (field, code) in [
        (row.sku.as_deref(), "missing_sku"),
        (row.name.as_deref(), "missing_name"),
        (row.description.as_deref(), "missing_description"),
        (
            row.country_of_origin.as_deref(),
            "missing_country_of_origin",
        ),
        (row.jurisdiction.as_deref(), "missing_jurisdiction"),
        (row.product_type.as_deref(), "missing_product_type"),
    ] {
        if field.map(|value| value.trim().is_empty()).unwrap_or(true) {
            return Err(row_error(row_number, code));
        }
    }
    if row
        .materials
        .iter()
        .all(|material| material.trim().is_empty())
    {
        return Err(row_error(row_number, "missing_materials"));
    }
    if row
        .intended_use
        .as_deref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        return Err(row_error(row_number, "missing_intended_use"));
    }
    Ok("ready")
}

fn row_error(row_number: usize, code: &'static str) -> Value {
    json!({ "row": row_number, "code": code, "message": format!("{code} for product import row") })
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

fn product_summary(row: sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "sku": row.get::<String, _>("sku"),
        "name": row.get::<String, _>("name"),
        "description": row.get::<String, _>("description"),
        "country_of_origin": row.get::<String, _>("country_of_origin"),
        "jurisdiction": row.get::<String, _>("jurisdiction"),
        "readiness_status": row.get::<String, _>("readiness_status"),
        "created_at": row.get::<String, _>("created_at")
    })
}

fn product_detail(row: sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "sku": row.get::<String, _>("sku"),
        "name": row.get::<String, _>("name"),
        "description": row.get::<String, _>("description"),
        "country_of_origin": row.get::<String, _>("country_of_origin"),
        "jurisdiction": row.get::<String, _>("jurisdiction"),
        "product_type": row.get::<Option<String>, _>("product_type"),
        "materials": row.get::<Value, _>("materials"),
        "intended_use": row.get::<Option<String>, _>("intended_use"),
        "readiness_status": row.get::<String, _>("readiness_status"),
        "source_row": row.get::<Value, _>("source_row"),
        "created_at": row.get::<String, _>("created_at")
    })
}

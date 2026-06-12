use axum::{http::HeaderMap, Json};
use serde_json::{json, Value};
use uuid::Uuid;

use super::{require_scope, AppState, ImportProductsRequest, ProductInput, ResourceAction};
use crate::{
    auth::authenticate_api_key,
    errors::ApiError,
    search::index::{build_product_search_document, ProductSearchDocument},
};

pub(super) async fn handle(
    state: AppState,
    headers: HeaderMap,
    payload: ImportProductsRequest,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ProductsWrite)?;
    let mut imported = 0_i64;
    let mut errors = Vec::new();

    for (index, row) in payload.rows.iter().enumerate() {
        match validate_product(index + 1, row) {
            Ok(ready) => {
                let product_id = persist_product(&state, context.tenant_id, row, ready).await?;
                index_product(&state, context.tenant_id, product_id, row)?;
                imported += 1;
                state.metrics.increment_imports_started(context.tenant_id);
            }
            Err(error) => errors.push(error),
        }
    }

    Ok(Json(json!({ "imported": imported, "errors": errors })))
}

async fn persist_product(
    state: &AppState,
    tenant_id: Uuid,
    row: &ProductInput,
    readiness: &'static str,
) -> Result<Uuid, ApiError> {
    let materials = json!(row.materials);
    let source_row = serde_json::to_value(row).map_err(|_| {
        ApiError::bad_request("invalid_product", "product row cannot be serialized")
    })?;
    let search_document = search_document(row);
    sqlx::query_scalar("INSERT INTO products (tenant_id, sku, name, description, country_of_origin, jurisdiction, product_type, materials, intended_use, readiness_status, source_row, search_document) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::product_readiness_status,$11,$12) ON CONFLICT (tenant_id, sku) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, country_of_origin = EXCLUDED.country_of_origin, jurisdiction = EXCLUDED.jurisdiction, product_type = EXCLUDED.product_type, materials = EXCLUDED.materials, intended_use = EXCLUDED.intended_use, readiness_status = EXCLUDED.readiness_status, source_row = EXCLUDED.source_row, search_document = EXCLUDED.search_document, updated_at = now() RETURNING id")
        .bind(tenant_id)
        .bind(required_field(&row.sku))
        .bind(optional_field(&row.name))
        .bind(required_field(&row.description))
        .bind(required_field(&row.country_of_origin))
        .bind(required_field(&row.jurisdiction))
        .bind(row.product_type.as_deref())
        .bind(materials)
        .bind(row.intended_use.as_deref())
        .bind(readiness)
        .bind(source_row)
        .bind(&search_document)
        .fetch_one(&state.pool)
        .await
        .map_err(ApiError::from_sqlx)
}

fn index_product(
    state: &AppState,
    tenant_id: Uuid,
    product_id: Uuid,
    row: &ProductInput,
) -> Result<(), ApiError> {
    state
        .product_search_index
        .index(ProductSearchDocument {
            tenant_id,
            product_id,
            sku: required_field(&row.sku).to_owned(),
            name: optional_field(&row.name).to_owned(),
            description: required_field(&row.description).to_owned(),
            materials: normalized_materials(row),
            intended_use: normalized_intended_use(row),
        })
        .map_err(|_| search_unavailable("product search index could not be updated"))
}

fn validate_product(row_number: usize, row: &ProductInput) -> Result<&'static str, Value> {
    for (field, code) in required_product_fields(row) {
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
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Err(row_error(row_number, "missing_intended_use"));
    }
    Ok("ready")
}

fn required_product_fields(row: &ProductInput) -> [(Option<&str>, &'static str); 6] {
    [
        (row.sku.as_deref(), "missing_sku"),
        (row.name.as_deref(), "missing_name"),
        (row.description.as_deref(), "missing_description"),
        (
            row.country_of_origin.as_deref(),
            "missing_country_of_origin",
        ),
        (row.jurisdiction.as_deref(), "missing_jurisdiction"),
        (row.product_type.as_deref(), "missing_product_type"),
    ]
}

fn search_document(row: &ProductInput) -> String {
    build_product_search_document(
        row.sku.as_deref().unwrap_or_default(),
        row.name.as_deref().unwrap_or_default(),
        row.description.as_deref().unwrap_or_default(),
        &row.materials,
        row.intended_use.as_deref(),
    )
}

fn normalized_materials(row: &ProductInput) -> Vec<String> {
    row.materials
        .iter()
        .map(|material| material.trim().to_owned())
        .filter(|material| !material.is_empty())
        .collect()
}

fn normalized_intended_use(row: &ProductInput) -> Option<String> {
    row.intended_use
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn required_field(value: &Option<String>) -> &str {
    value.as_deref().expect("validated product field").trim()
}

fn optional_field(value: &Option<String>) -> &str {
    value.as_deref().map(str::trim).unwrap_or("")
}

fn row_error(row_number: usize, code: &'static str) -> Value {
    json!({ "row": row_number, "code": code, "message": format!("{code} for product import row") })
}

fn search_unavailable(message: &'static str) -> ApiError {
    ApiError::service_unavailable("product_search_unavailable", message)
}

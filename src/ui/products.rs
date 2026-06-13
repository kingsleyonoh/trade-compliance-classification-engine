use axum::{
    extract::{Form, State},
    http::HeaderMap,
    response::{Html, IntoResponse, Redirect, Response},
};
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    app::{classifications as classification_api, products as product_api, AppState},
    errors::ApiError,
};

use super::{
    layout::{error_page, escape, page},
    session::{ui_context, ui_session_headers},
};

#[derive(Debug, Deserialize)]
pub struct ProductImportForm {
    sku: String,
    name: String,
    description: String,
    country_of_origin: String,
    jurisdiction: String,
    product_type: String,
    materials: String,
    intended_use: String,
}

#[derive(Debug, Deserialize)]
pub struct RunSelectedForm {
    product_ids: Uuid,
}

pub async fn product_import(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if ui_context(&state, &headers).await.is_err() {
        Redirect::to("/ui/login").into_response()
    } else {
        product_import_page(None)
    }
}

pub async fn submit_product_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<ProductImportForm>,
) -> Response {
    let Ok(session_headers) = ui_session_headers(&headers) else {
        return Redirect::to("/ui/login").into_response();
    };
    let payload = product_api::ImportProductsRequest {
        rows: vec![product_api::ProductInput {
            sku: some_trimmed(form.sku),
            name: some_trimmed(form.name),
            description: some_trimmed(form.description),
            country_of_origin: some_trimmed(form.country_of_origin),
            jurisdiction: some_trimmed(form.jurisdiction),
            product_type: some_trimmed(form.product_type),
            materials: split_csv(&form.materials),
            intended_use: some_trimmed(form.intended_use),
        }],
    };
    match product_api::import_products(State(state), session_headers, axum::Json(payload)).await {
        Ok(axum::Json(body)) => product_import_page(Some(format!(
            "Imported {} product row(s); {} validation error(s).",
            body["imported"].as_i64().unwrap_or(0),
            body["errors"]
                .as_array()
                .map(|items| items.len())
                .unwrap_or(0)
        ))),
        Err(error) => product_import_page(Some(format!("Import failed: {:?}", error))),
    }
}

pub async fn products(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Ok(context) = ui_context(&state, &headers).await else {
        return Redirect::to("/ui/login").into_response();
    };
    products_page(&state, context.tenant_id, None).await
}

pub async fn submit_run_selected(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<RunSelectedForm>,
) -> Response {
    let Ok(context) = ui_context(&state, &headers).await else {
        return Redirect::to("/ui/login").into_response();
    };
    let Ok(session_headers) = ui_session_headers(&headers) else {
        return Redirect::to("/ui/login").into_response();
    };
    let payload = classification_api::RunClassificationsRequest {
        product_ids: vec![form.product_ids],
    };
    let status = match classification_api::run_classifications(
        State(state.clone()),
        session_headers,
        axum::Json(payload),
    )
    .await
    {
        Ok((_, axum::Json(body))) => format!(
            "Classification queued for {} product(s).",
            body["runs"].as_array().map(|runs| runs.len()).unwrap_or(0)
        ),
        Err(error) => format!("Classification run could not start: {:?}", error),
    };
    products_page(&state, context.tenant_id, Some(status)).await
}

async fn products_page(state: &AppState, tenant_id: Uuid, status: Option<String>) -> Response {
    match product_rows(state, tenant_id).await {
        Ok(rows) => Html(page("Products", &products_body(rows, status.as_deref()))).into_response(),
        Err(error) => error_page("Products unavailable", &error).into_response(),
    }
}

async fn product_rows(
    state: &AppState,
    tenant_id: Uuid,
) -> Result<Vec<sqlx::postgres::PgRow>, ApiError> {
    sqlx::query("SELECT id, sku, name, readiness_status::text AS readiness_status FROM products WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50").bind(tenant_id).fetch_all(&state.pool).await.map_err(ApiError::from_sqlx)
}

fn product_import_page(status: Option<String>) -> Response {
    let readiness = if status.is_some() {
        "Product readiness captured; ready products can be classified from the Products screen."
    } else {
        "Materials and intended use are required before classification."
    };
    Html(page("Import products", &format!(r#"<section class="panel"><form method="post" action="/ui/products/import"><label>SKU <input name="sku" required></label><label>Name <input name="name" required></label><label>Description <textarea name="description" required></textarea></label><label>Country of origin <input name="country_of_origin" value="NG" required></label><label>Jurisdiction <select name="jurisdiction"><option>US</option><option>EU</option><option>UK</option><option>NG</option></select></label><label>Product type <input name="product_type" required></label><label>Materials <input name="materials" required></label><label>Intended use <input name="intended_use" required></label><output data-testid="import-status">{}</output><output data-testid="readiness-feedback">{}</output><button>Import product</button></form></section>"#, escape(status.as_deref().unwrap_or("Ready for JSON-backed product import.")), escape(readiness)))).into_response()
}

fn products_body(rows: Vec<sqlx::postgres::PgRow>, status: Option<&str>) -> String {
    let mut body = format!(
        r#"<section class="table-card" data-testid="products-table-card"><form method="post" action="/ui/classifications/run"><output data-testid="run-status">{}</output><table><tbody>"#,
        escape(status.unwrap_or("Select ready products and run classification."))
    );
    for row in rows {
        let id: Uuid = row.get("id");
        let sku: String = row.get("sku");
        body.push_str(&format!(r#"<tr><td><input aria-label="Select product {}" type="checkbox" name="product_ids" value="{}"></td><td>{}</td><td>{}</td><td>{}</td></tr>"#, escape(&sku), id, escape(&sku), escape(&row.get::<String, _>("name")), escape(&row.get::<String, _>("readiness_status"))));
    }
    body.push_str(r#"</tbody></table><button>Run selected</button></form></section>"#);
    body
}

fn split_csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn some_trimmed(value: String) -> Option<String> {
    let value = value.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

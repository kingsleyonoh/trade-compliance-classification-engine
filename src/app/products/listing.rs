use axum::{http::HeaderMap, Json};
use serde_json::{json, Value};
use sqlx::{Postgres, QueryBuilder};
use uuid::Uuid;

use super::{require_scope, response, AppState, ListQuery, ResourceAction};
use crate::{auth::authenticate_api_key, errors::ApiError};

pub(super) async fn handle(
    state: AppState,
    headers: HeaderMap,
    query: ListQuery,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ProductsRead)?;
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let cursor = parse_cursor(query.cursor.as_deref())?;
    let search = resolve_search(&state, context.tenant_id, query.query.as_deref(), limit)?;
    let rows = fetch_products(&state, context.tenant_id, cursor, limit, &search).await?;
    let has_more = rows.len() as i64 > limit;
    let items = rows
        .into_iter()
        .take(limit as usize)
        .map(response::product_summary)
        .collect::<Vec<_>>();
    Ok(Json(
        json!({ "items": items, "next_cursor": next_cursor(has_more, &items) }),
    ))
}

struct SearchFilter {
    ids: Option<Vec<Uuid>>,
    persisted_terms: Option<Vec<String>>,
}

fn parse_cursor(cursor: Option<&str>) -> Result<Option<Uuid>, ApiError> {
    match cursor.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Uuid::parse_str(value)
            .map(Some)
            .map_err(|_| ApiError::bad_request("invalid_cursor", "cursor must be a product id")),
        None => Ok(None),
    }
}

fn resolve_search(
    state: &AppState,
    tenant_id: Uuid,
    query: Option<&str>,
    limit: i64,
) -> Result<SearchFilter, ApiError> {
    let query = query.map(str::trim).filter(|value| !value.is_empty());
    let ids = query
        .map(|text| search_ids(state, tenant_id, text, limit))
        .transpose()?;
    let persisted_terms = query
        .map(normalized_search_terms)
        .filter(|terms| !terms.is_empty());
    Ok(SearchFilter {
        ids,
        persisted_terms,
    })
}

fn search_ids(
    state: &AppState,
    tenant_id: Uuid,
    query: &str,
    limit: i64,
) -> Result<Vec<Uuid>, ApiError> {
    state
        .product_search_index
        .search(tenant_id, query, limit as usize + 1)
        .map(|matches| {
            matches
                .into_iter()
                .map(|document| document.product_id)
                .collect()
        })
        .map_err(|_| {
            ApiError::service_unavailable(
                "product_search_unavailable",
                "product search index could not be searched",
            )
        })
}

async fn fetch_products(
    state: &AppState,
    tenant_id: Uuid,
    cursor: Option<Uuid>,
    limit: i64,
    search: &SearchFilter,
) -> Result<Vec<sqlx::postgres::PgRow>, ApiError> {
    let mut builder = base_query(tenant_id);
    push_search_filter(&mut builder, search);
    if let Some(cursor) = cursor {
        builder.push(" AND id > ");
        builder.push_bind(cursor);
    }
    builder.push(" ORDER BY id ASC LIMIT ");
    builder.push_bind(limit + 1);
    builder
        .build()
        .fetch_all(&state.pool)
        .await
        .map_err(ApiError::from_sqlx)
}

fn base_query(tenant_id: Uuid) -> QueryBuilder<'static, Postgres> {
    let mut builder = QueryBuilder::new("SELECT id, sku, name, description, country_of_origin, jurisdiction, readiness_status::text AS readiness_status, search_document, created_at::text AS created_at FROM products WHERE tenant_id = ");
    builder.push_bind(tenant_id);
    builder
}

fn push_search_filter(builder: &mut QueryBuilder<Postgres>, search: &SearchFilter) {
    match (search.ids.as_ref(), search.persisted_terms.as_ref()) {
        (Some(ids), Some(terms)) if !ids.is_empty() => push_id_or_terms_filter(builder, ids, terms),
        (Some(ids), _) if !ids.is_empty() => push_id_filter(builder, ids),
        (_, Some(terms)) => push_terms_filter(builder, terms),
        _ => {}
    }
}

fn push_id_or_terms_filter(builder: &mut QueryBuilder<Postgres>, ids: &[Uuid], terms: &[String]) {
    builder.push(" AND (id = ANY(");
    builder.push_bind(ids.to_vec());
    builder.push(") OR ");
    push_persisted_search_terms(builder, terms);
    builder.push(")");
}

fn push_id_filter(builder: &mut QueryBuilder<Postgres>, ids: &[Uuid]) {
    builder.push(" AND id = ANY(");
    builder.push_bind(ids.to_vec());
    builder.push(")");
}

fn push_terms_filter(builder: &mut QueryBuilder<Postgres>, terms: &[String]) {
    builder.push(" AND ");
    push_persisted_search_terms(builder, terms);
}

fn push_persisted_search_terms(builder: &mut QueryBuilder<Postgres>, terms: &[String]) {
    builder.push("(");
    for (index, term) in terms.iter().enumerate() {
        if index > 0 {
            builder.push(" AND ");
        }
        builder.push("lower(search_document) LIKE ");
        builder.push_bind(format!("%{term}%"));
    }
    builder.push(")");
}

fn normalized_search_terms(query: &str) -> Vec<String> {
    query
        .to_ascii_lowercase()
        .split_whitespace()
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_owned)
        .collect()
}

fn next_cursor(has_more: bool, items: &[Value]) -> Option<String> {
    has_more
        .then(|| {
            items
                .last()
                .and_then(|item| item["id"].as_str())
                .map(str::to_owned)
        })
        .flatten()
}

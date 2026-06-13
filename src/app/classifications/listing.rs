use axum::{http::HeaderMap, Json};
use serde_json::{json, Value};
use sqlx::{Postgres, QueryBuilder};

use super::{require_scope, rows, AppState, ListClassificationsQuery, ResourceAction};
use crate::{
    auth::{authenticate_api_key, TenantContext},
    errors::ApiError,
};

pub(super) async fn handle(
    state: AppState,
    headers: HeaderMap,
    query: ListClassificationsQuery,
) -> Result<Json<Value>, ApiError> {
    let context = authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    require_scope(context.scope, ResourceAction::ClassificationsRead)?;
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let rows = fetch_classification_page(&state, &context, &query, limit).await?;
    let has_more = rows.len() as i64 > limit;
    let items = rows
        .into_iter()
        .take(limit as usize)
        .map(rows::classification_json)
        .collect::<Vec<_>>();
    Ok(Json(
        json!({ "items": items, "next_cursor": next_cursor(has_more, &items) }),
    ))
}

async fn fetch_classification_page(
    state: &AppState,
    context: &TenantContext,
    query: &ListClassificationsQuery,
    limit: i64,
) -> Result<Vec<sqlx::postgres::PgRow>, ApiError> {
    let mut builder = QueryBuilder::new(format!(
        "SELECT {} FROM classification_runs WHERE tenant_id = ",
        rows::SELECT
    ));
    builder.push_bind(context.tenant_id);
    push_optional_filters(&mut builder, query);
    builder.push(" ORDER BY id ASC LIMIT ");
    builder.push_bind(limit + 1);
    builder
        .build()
        .fetch_all(&state.pool)
        .await
        .map_err(ApiError::from_sqlx)
}

fn push_optional_filters(builder: &mut QueryBuilder<Postgres>, query: &ListClassificationsQuery) {
    if let Some(status) = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        builder.push(" AND status = ");
        builder.push_bind(status.to_owned());
    }
    if let Some(cursor) = query.cursor {
        builder.push(" AND id > ");
        builder.push_bind(cursor);
    }
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

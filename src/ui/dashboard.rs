use axum::{
    extract::State,
    http::HeaderMap,
    response::{Html, IntoResponse, Redirect, Response},
};
use sqlx::Row;
use uuid::Uuid;

use crate::{app::AppState, errors::ApiError};

use super::{
    layout::{error_page, page},
    session::ui_context,
};

#[derive(Debug, Default)]
struct DashboardCounts {
    products: i64,
    queued_jobs: i64,
    exports: i64,
}

pub async fn dashboard(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Ok(context) = ui_context(&state, &headers).await else {
        return Redirect::to("/ui/login").into_response();
    };
    match dashboard_counts(&state, context.tenant_id).await {
        Ok(c) => Html(page("Compliance dashboard", &format!(r#"<section class="metric-grid" data-testid="dashboard-metrics"><article><strong>{}</strong><span>Products</span></article><article><strong>{}</strong><span>Queued jobs</span></article><article><strong>{}</strong><span>Audit exports</span></article></section>"#, c.products, c.queued_jobs, c.exports))).into_response(),
        Err(e) => error_page("Dashboard unavailable", &e).into_response(),
    }
}

async fn dashboard_counts(state: &AppState, tenant_id: Uuid) -> Result<DashboardCounts, ApiError> {
    let row = sqlx::query("SELECT (SELECT count(*) FROM products WHERE tenant_id = $1) AS products, (SELECT count(*) FROM classification_jobs WHERE tenant_id = $1 AND status IN ('queued','leased')) AS queued_jobs, (SELECT count(*) FROM audit_exports WHERE tenant_id = $1) AS exports")
        .bind(tenant_id).fetch_one(&state.pool).await.map_err(ApiError::from_sqlx)?;
    Ok(DashboardCounts {
        products: row.get("products"),
        queued_jobs: row.get("queued_jobs"),
        exports: row.get("exports"),
    })
}

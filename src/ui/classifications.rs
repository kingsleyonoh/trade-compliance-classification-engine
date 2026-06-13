use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::{Html, IntoResponse, Redirect, Response},
};
use sqlx::Row;
use uuid::Uuid;

use crate::{app::AppState, errors::ApiError};

use super::{
    layout::{error_page, escape, page},
    session::ui_context,
};

pub async fn classifications(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Ok(context) = ui_context(&state, &headers).await else {
        return Redirect::to("/ui/login").into_response();
    };
    match classification_rows(&state, context.tenant_id).await {
        Ok(rows) => Html(page("Classifications", &classification_table(rows))).into_response(),
        Err(e) => error_page("Classifications unavailable", &e).into_response(),
    }
}

pub async fn classification_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Response {
    let Ok(context) = ui_context(&state, &headers).await else {
        return Redirect::to("/ui/login").into_response();
    };
    match classification_detail_row(&state, context.tenant_id, id).await {
        Ok(row) => Html(page(
            "Classification detail",
            &classification_detail_body(&row, None),
        ))
        .into_response(),
        Err(e) => error_page("Classification unavailable", &e).into_response(),
    }
}

pub async fn classification_detail_legacy(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let Ok(context) = ui_context(&state, &headers).await else {
        return Redirect::to("/ui/login").into_response();
    };
    match classification_rows(&state, context.tenant_id).await {
        Ok(mut rows) => rows.pop().map(|row| Html(page("Classification detail", &classification_detail_body(&row, None))).into_response()).unwrap_or_else(|| Html(page("Classification detail", r#"<section data-testid="classification-trace"><h2>Evidence trace</h2><p>No classifications yet. Import products and run selected items first.</p></section>"#)).into_response()),
        Err(e) => error_page("Classification unavailable", &e).into_response(),
    }
}

pub(crate) async fn classification_rows(
    state: &AppState,
    tenant_id: Uuid,
) -> Result<Vec<sqlx::postgres::PgRow>, ApiError> {
    sqlx::query("SELECT r.id, p.sku, r.status::text AS status, r.selected_code, r.confidence::text AS confidence, r.risk_band, r.rule_pack_version FROM classification_runs r JOIN products p ON p.id=r.product_id AND p.tenant_id=r.tenant_id WHERE r.tenant_id=$1 ORDER BY r.created_at DESC, r.id DESC LIMIT 50").bind(tenant_id).fetch_all(&state.pool).await.map_err(ApiError::from_sqlx)
}

pub(crate) async fn classification_detail_row(
    state: &AppState,
    tenant_id: Uuid,
    id: Uuid,
) -> Result<sqlx::postgres::PgRow, ApiError> {
    sqlx::query("SELECT r.id, p.sku, r.status::text AS status, r.selected_code, r.confidence::text AS confidence, r.risk_band, r.rule_pack_version FROM classification_runs r JOIN products p ON p.id=r.product_id AND p.tenant_id=r.tenant_id WHERE r.tenant_id=$1 AND r.id=$2").bind(tenant_id).bind(id).fetch_optional(&state.pool).await.map_err(ApiError::from_sqlx)?.ok_or_else(|| ApiError::not_found("classification_not_found", "classification run was not found for this tenant"))
}

fn classification_table(rows: Vec<sqlx::postgres::PgRow>) -> String {
    let mut body = r#"<section class="table-card"><table><tbody>"#.to_owned();
    for row in rows {
        let id: Uuid = row.get("id");
        let sku: String = row.get("sku");
        body.push_str(&format!(r#"<tr><td>{}</td><td>{}</td><td><a href="/ui/classifications/{}">View classification for {}</a></td></tr>"#, escape(&row.get::<String, _>("status")), escape(row.get::<Option<String>, _>("selected_code").as_deref().unwrap_or("pending")), id, escape(&sku)));
    }
    body.push_str("</tbody></table></section>");
    body
}

pub(crate) fn classification_detail_body(
    row: &sqlx::postgres::PgRow,
    export_status: Option<&str>,
) -> String {
    let id: Uuid = row.get("id");
    format!(
        r#"<section data-testid="classification-trace"><h2>Evidence trace</h2><p>Product {}</p><dl><dt>Status</dt><dd>{}</dd><dt>Selected code</dt><dd>{}</dd><dt>Confidence</dt><dd>{}</dd><dt>Risk band</dt><dd>{}</dd><dt>Rule-pack version</dt><dd>{}</dd></dl><ol><li>Matched facts</li><li>Matched rules</li><li>Rejected candidates</li></ol><form method="post" action="/ui/audit-exports"><input type="hidden" name="classification_run_id" value="{}"><input type="hidden" name="format" value="json"><button>Create audit export</button></form><output data-testid="export-status">{}</output></section>"#,
        escape(&row.get::<String, _>("sku")),
        escape(&row.get::<String, _>("status")),
        escape(
            row.get::<Option<String>, _>("selected_code")
                .as_deref()
                .unwrap_or("pending")
        ),
        escape(
            row.get::<Option<String>, _>("confidence")
                .as_deref()
                .unwrap_or("pending")
        ),
        escape(
            row.get::<Option<String>, _>("risk_band")
                .as_deref()
                .unwrap_or("pending")
        ),
        escape(
            row.get::<Option<String>, _>("rule_pack_version")
                .as_deref()
                .unwrap_or("pending")
        ),
        id,
        escape(export_status.unwrap_or("Create an immutable audit export after completion."))
    )
}

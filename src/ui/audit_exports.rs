use axum::{
    extract::{Form, Path, State},
    http::{header, HeaderMap, HeaderValue},
    response::{Html, IntoResponse, Redirect, Response},
};
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    app::{audit_exports as audit_api, AppState},
    errors::ApiError,
};

use super::{
    classifications::{classification_detail_body, classification_detail_row},
    layout::{error_page, escape, page},
    session::{ui_context, ui_session_headers},
};

#[derive(Debug, Deserialize)]
pub struct AuditExportForm {
    classification_run_id: Uuid,
    format: String,
}

pub async fn audit_exports(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Ok(context) = ui_context(&state, &headers).await else {
        return Redirect::to("/ui/login").into_response();
    };
    match audit_export_rows(&state, context.tenant_id).await {
        Ok(rows) => Html(page("Audit exports", &audit_exports_body(rows))).into_response(),
        Err(e) => error_page("Audit exports unavailable", &e).into_response(),
    }
}

pub async fn download_ui_audit_export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Response {
    let Ok(session_headers) = ui_session_headers(&headers) else {
        return Redirect::to("/ui/login").into_response();
    };
    match audit_api::download_audit_export(State(state), session_headers, Path(id)).await {
        Ok(body) => audit_download_response(id, body),
        Err(e) => error_page("Audit export download unavailable", &e).into_response(),
    }
}

pub async fn submit_audit_export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<AuditExportForm>,
) -> Response {
    let Ok(context) = ui_context(&state, &headers).await else {
        return Redirect::to("/ui/login").into_response();
    };
    let Ok(session_headers) = ui_session_headers(&headers) else {
        return Redirect::to("/ui/login").into_response();
    };
    let payload = audit_api::CreateAuditExportRequest {
        classification_run_id: form.classification_run_id,
        format: form.format,
    };
    let status = create_export_status(&state, session_headers, payload).await;
    match classification_detail_row(&state, context.tenant_id, form.classification_run_id).await {
        Ok(row) => Html(page(
            "Classification detail",
            &classification_detail_body(&row, Some(&status)),
        ))
        .into_response(),
        Err(e) => error_page("Classification unavailable", &e).into_response(),
    }
}

async fn create_export_status(
    state: &AppState,
    session_headers: HeaderMap,
    payload: audit_api::CreateAuditExportRequest,
) -> String {
    match audit_api::create_audit_export(State(state.clone()), session_headers, axum::Json(payload))
        .await
    {
        Ok((_, axum::Json(body))) => format!(
            "Audit export created and ready. Download id {}.",
            body["id"].as_str().unwrap_or("unknown")
        ),
        Err(e) => format!("Audit export queued/waiting: {:?}", e),
    }
}

fn audit_download_response(id: Uuid, body: String) -> Response {
    let filename = format!("audit-export-{id}.json");
    let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
        .expect("audit export filename is ASCII and header-safe");
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            ),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        body,
    )
        .into_response()
}

async fn audit_export_rows(
    state: &AppState,
    tenant_id: Uuid,
) -> Result<Vec<sqlx::postgres::PgRow>, ApiError> {
    sqlx::query("SELECT e.id, e.classification_run_id, e.status::text AS status, e.format::text AS format, e.created_at::text AS created_at, p.sku FROM audit_exports e JOIN classification_runs r ON r.id=e.classification_run_id AND r.tenant_id=e.tenant_id JOIN products p ON p.id=r.product_id AND p.tenant_id=r.tenant_id WHERE e.tenant_id=$1 ORDER BY e.created_at DESC, e.id DESC LIMIT 50").bind(tenant_id).fetch_all(&state.pool).await.map_err(ApiError::from_sqlx)
}

fn audit_exports_body(rows: Vec<sqlx::postgres::PgRow>) -> String {
    let mut body =
        r#"<section data-testid="audit-exports" class="table-card"><table><tbody>"#.to_owned();
    if rows.is_empty() {
        body.push_str(
            "<tr><td>No audit exports yet. Create one from a classification detail.</td></tr>",
        );
    }
    for row in rows {
        body.push_str(&audit_export_row(row));
    }
    body.push_str("</tbody></table></section>");
    body
}

fn audit_export_row(row: sqlx::postgres::PgRow) -> String {
    let id: Uuid = row.get("id");
    let run_id: Uuid = row.get("classification_run_id");
    let format: String = row.get("format");
    let sku: String = row.get("sku");
    let link_label = format!("Download {} audit export", format.to_ascii_uppercase());
    let filename = format!("audit-export-{id}.json");
    format!(
        r#"<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td><a href="/ui/audit-exports/{}/download" download="{}">{}</a></td></tr>"#,
        escape(&sku),
        run_id,
        escape(&row.get::<String, _>("status")),
        escape(&row.get::<String, _>("created_at")),
        id,
        escape(&filename),
        escape(&link_label)
    )
}

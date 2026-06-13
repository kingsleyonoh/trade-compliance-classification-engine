use axum::{
    extract::{Form, Path, State},
    http::HeaderMap,
    response::{Html, IntoResponse, Redirect, Response},
};
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    app::AppState,
    errors::ApiError,
    reviews::{create_reviewer_override, OverrideRequest},
};

use super::{
    layout::{error_page, escape, page},
    session::ui_context,
};

#[derive(Debug, Deserialize)]
pub struct ReviewOverrideForm {
    override_code: String,
    reason_code: String,
    note: Option<String>,
    structured_correction: Option<String>,
}

pub async fn reviews(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Ok(context) = ui_context(&state, &headers).await else {
        return Redirect::to("/ui/login").into_response();
    };
    reviews_page(&state, context.tenant_id, None).await
}

pub async fn submit_review_override(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Form(form): Form<ReviewOverrideForm>,
) -> Response {
    let Ok(context) = ui_context(&state, &headers).await else {
        return Redirect::to("/ui/login").into_response();
    };
    let structured_correction =
        match parse_structured_correction(form.structured_correction.as_deref()) {
            Ok(value) => value,
            Err(message) => return reviews_page(&state, context.tenant_id, Some(message)).await,
        };
    let payload = OverrideRequest {
        override_code: form.override_code,
        reason_code: form.reason_code,
        note: form.note,
        structured_correction,
    };
    let status = match create_reviewer_override(&state.pool, &context, id, payload).await {
        Ok(_) => "Override recorded and preserved in append-only history.".to_owned(),
        Err(error) => format!("Override could not be recorded: {:?}", error),
    };
    reviews_page(&state, context.tenant_id, Some(status)).await
}

async fn reviews_page(state: &AppState, tenant_id: Uuid, status: Option<String>) -> Response {
    match review_rows(state, tenant_id).await {
        Ok(rows) => {
            Html(page("Review queue", &reviews_body(rows, status.as_deref()))).into_response()
        }
        Err(e) => error_page("Review queue unavailable", &e).into_response(),
    }
}

async fn review_rows(
    state: &AppState,
    tenant_id: Uuid,
) -> Result<Vec<sqlx::postgres::PgRow>, ApiError> {
    sqlx::query("SELECT r.id, p.sku, r.status::text AS status, r.selected_code, r.confidence::text AS confidence, r.risk_band, o.override_code, o.reason_code, o.note, o.structured_correction::text AS structured_correction FROM classification_runs r JOIN products p ON p.id=r.product_id AND p.tenant_id=r.tenant_id LEFT JOIN LATERAL (SELECT override_code, reason_code, note, structured_correction FROM reviewer_overrides WHERE tenant_id=r.tenant_id AND classification_run_id=r.id ORDER BY created_at DESC, id DESC LIMIT 1) o ON true WHERE r.tenant_id=$1 ORDER BY r.created_at DESC, r.id DESC LIMIT 50").bind(tenant_id).fetch_all(&state.pool).await.map_err(ApiError::from_sqlx)
}

fn reviews_body(rows: Vec<sqlx::postgres::PgRow>, status: Option<&str>) -> String {
    let mut body = format!(
        r#"<section data-testid="review-queue" class="table-card" aria-keyshortcuts="a o b"><output data-testid="review-status">{}</output><table><tbody>"#,
        escape(status.unwrap_or("Select a classification run to approve, override, or block."))
    );
    if rows.is_empty() {
        body.push_str("<tr><td>No classifications are ready for review yet.</td></tr>");
    }
    for row in rows {
        let id: Uuid = row.get("id");
        let sku: String = row.get("sku");
        let latest = row
            .get::<Option<String>, _>("override_code")
            .unwrap_or_else(|| "No override recorded".to_owned());
        let reason = row
            .get::<Option<String>, _>("reason_code")
            .unwrap_or_else(|| "not recorded".to_owned());
        let note = row.get::<Option<String>, _>("note").unwrap_or_default();
        let structured = row
            .get::<Option<String>, _>("structured_correction")
            .unwrap_or_else(|| "{}".to_owned());
        body.push_str(&format!(r#"<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>Latest override: {} ({}) {} {}</td><td><form data-run-id="{}" method="post" action="/ui/reviews/{}/override"><label>Override code <input name="override_code" value="{}" required></label><label>Reason code <select name="reason_code"><option value="missing_material">missing_material</option><option value="wrong_use_case">wrong_use_case</option><option value="rule_conflict">rule_conflict</option><option value="supplier_evidence">supplier_evidence</option><option value="legal_guidance">legal_guidance</option><option value="other">other</option></select></label><label>Review note <textarea name="note"></textarea></label><label>Structured correction <textarea name="structured_correction">{{}}</textarea></label><button>Record override</button></form></td></tr>"#, escape(&sku), id, escape(&row.get::<String, _>("status")), escape(row.get::<Option<String>, _>("selected_code").as_deref().unwrap_or("pending")), escape(&latest), escape(&reason), escape(&note), escape(&structured), id, id, escape(row.get::<Option<String>, _>("selected_code").as_deref().unwrap_or(""))));
    }
    body.push_str(
        "</tbody></table><p>Keyboard flow: A approve, O override, B block.</p></section>",
    );
    body
}

fn parse_structured_correction(value: Option<&str>) -> Result<Option<serde_json::Value>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    serde_json::from_str(value)
        .map(Some)
        .map_err(|_| "Structured correction must be valid JSON.".to_owned())
}

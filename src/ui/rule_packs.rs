use axum::{
    extract::{Form, Path, State},
    http::HeaderMap,
    response::{Html, IntoResponse, Redirect, Response},
};
use serde::Deserialize;
use uuid::Uuid;

use crate::app::{rule_packs as rule_pack_api, AppState};

use super::{
    layout::{escape, page},
    session::{ui_context, ui_session_headers},
};

#[derive(Debug, Deserialize)]
pub struct RulePackForm {
    name: String,
    version: String,
    jurisdiction: String,
    source: String,
}

pub async fn rule_packs(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if ui_context(&state, &headers).await.is_err() {
        Redirect::to("/ui/login").into_response()
    } else {
        rule_pack_page(None, None)
    }
}

pub async fn submit_rule_pack(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<RulePackForm>,
) -> Response {
    let Ok(session_headers) = ui_session_headers(&headers) else {
        return Redirect::to("/ui/login").into_response();
    };
    let payload = rule_pack_api::UploadRulePackRequest {
        name: form.name,
        version: form.version,
        jurisdiction: form.jurisdiction,
        source: form.source,
    };
    match rule_pack_api::upload_rule_pack(State(state), session_headers, axum::Json(payload)).await
    {
        Ok((_, axum::Json(body))) => rule_pack_page(
            Some("Uploaded and valid rule pack draft.".to_owned()),
            body["id"]
                .as_str()
                .and_then(|value| Uuid::parse_str(value).ok()),
        ),
        Err(error) => rule_pack_page(Some(format!("Rule pack upload failed: {:?}", error)), None),
    }
}

pub async fn validate_rule_pack(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Response {
    let Ok(session_headers) = ui_session_headers(&headers) else {
        return Redirect::to("/ui/login").into_response();
    };
    match rule_pack_api::validate_rule_pack(State(state), session_headers, Path(id)).await {
        Ok(_) => rule_pack_page(Some("Rule pack is valid.".to_owned()), Some(id)),
        Err(e) => rule_pack_page(Some(format!("Validation failed: {:?}", e)), Some(id)),
    }
}

pub async fn activate_rule_pack(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Response {
    let Ok(session_headers) = ui_session_headers(&headers) else {
        return Redirect::to("/ui/login").into_response();
    };
    match rule_pack_api::activate_rule_pack(State(state), session_headers, Path(id)).await {
        Ok(_) => rule_pack_page(Some("Rule pack active.".to_owned()), Some(id)),
        Err(e) => rule_pack_page(Some(format!("Activation failed: {:?}", e)), Some(id)),
    }
}

fn rule_pack_page(status: Option<String>, id: Option<Uuid>) -> Response {
    let actions = id.map(rule_pack_actions).unwrap_or_default();
    let body = format!(
        r#"<section data-testid="rule-pack-management"><form method="post" action="/ui/rule-packs"><label>Rule pack name <input name="name" required></label><label>Version <input name="version" required></label><label>Jurisdiction <select name="jurisdiction"><option>US</option><option>EU</option><option>UK</option><option>NG</option></select></label><label>Rule pack source <textarea name="source" required></textarea></label><button>Upload rule pack</button></form>{}<output data-testid="rule-pack-status">{}</output></section>"#,
        actions,
        escape(
            status
                .as_deref()
                .unwrap_or("Upload a JSON or YAML rule pack to validate.")
        )
    );
    Html(page("Rule packs", &body)).into_response()
}

fn rule_pack_actions(id: Uuid) -> String {
    format!(
        "<form method=\"post\" action=\"/ui/rule-packs/{id}/validate\"><button>Validate</button></form><form method=\"post\" action=\"/ui/rule-packs/{id}/activate\"><button>Activate</button></form>"
    )
}

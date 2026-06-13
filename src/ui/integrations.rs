use axum::{
    extract::State,
    http::HeaderMap,
    response::{Html, IntoResponse, Redirect, Response},
};

use crate::app::AppState;

use super::{layout::page, session::ui_context};

pub async fn integrations(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if ui_context(&state, &headers).await.is_err() {
        return Redirect::to("/ui/login").into_response();
    }
    Html(page("Integration settings", r#"<section data-testid="integration-controls"><label><input type="checkbox" disabled> RAG adapter disabled — optional and non-blocking until configured</label><label><input type="checkbox" disabled> Notification Hub disabled — optional and non-blocking until configured</label><label><input type="checkbox" disabled> Workflow Engine disabled — optional and non-blocking until configured</label><button disabled title="Configure adapter URL and secret first">Run health check</button><p>Optional integrations are disabled by default and never block core classification, review, or audit export flows.</p></section>"#)).into_response()
}

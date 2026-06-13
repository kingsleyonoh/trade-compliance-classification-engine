use axum::{
    extract::{Form, State},
    http::{header, HeaderMap, HeaderValue},
    response::{Html, IntoResponse, Redirect, Response},
};
use serde::Deserialize;

use crate::{
    app::AppState,
    auth::{authenticate_api_key, TenantContext},
    errors::ApiError,
};

use super::layout::page;

const SESSION_COOKIE: &str = "tcce_api_key";

#[derive(Debug, Deserialize)]
pub struct LoginForm {
    api_key: String,
}

pub async fn login_page() -> Html<String> {
    Html(page(
        "API key sign in",
        r#"<section class="panel"><p>Enter a local tenant API key to open the browser workbench.</p><form method="post" action="/ui/login"><label>Tenant API key <input name="api_key" type="password" autocomplete="off" required></label><button>Continue</button></form></section>"#,
    ))
}

pub async fn submit_login(
    State(state): State<AppState>,
    Form(form): Form<LoginForm>,
) -> Result<Response, ApiError> {
    let key = form.api_key.trim();
    let headers = api_headers(key)?;
    authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await?;
    let mut response = Redirect::to("/ui/dashboard").into_response();
    let cookie = format!(
        "{}={}; Path=/ui; HttpOnly; SameSite=Lax; Max-Age=28800",
        SESSION_COOKIE,
        cookie_escape(key)
    );
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|_| invalid_session())?,
    );
    Ok(response)
}

pub(crate) async fn ui_context(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<TenantContext, ApiError> {
    let headers = ui_session_headers(headers)?;
    authenticate_api_key(&state.pool, &headers, &state.api_key_pepper).await
}

pub(crate) fn ui_session_headers(headers: &HeaderMap) -> Result<HeaderMap, ApiError> {
    if headers.contains_key("x-api-key") {
        return Ok(headers.clone());
    }
    let key = session_key(headers).ok_or_else(|| {
        ApiError::unauthorized("missing_api_key", "browser session API key is missing")
    })?;
    api_headers(&key)
}

fn api_headers(key: &str) -> Result<HeaderMap, ApiError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-api-key",
        HeaderValue::from_str(key).map_err(|_| invalid_session())?,
    );
    Ok(headers)
}

fn session_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(name, value)| (name == SESSION_COOKIE).then(|| value.to_owned()))
}

fn cookie_escape(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
        .collect()
}

fn invalid_session() -> ApiError {
    ApiError::unauthorized("invalid_api_key", "browser session API key is invalid")
}

use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use serde_json::Value;
use trade_compliance_classification_engine::auth::policies::{can_scope, ResourceAction};
use trade_compliance_classification_engine::auth::{TenantContext, UserScope};
use trade_compliance_classification_engine::cache::CachedValue;
use trade_compliance_classification_engine::config::AppConfig;
use trade_compliance_classification_engine::db::DatabaseConfig;
use trade_compliance_classification_engine::errors::ApiError;
use trade_compliance_classification_engine::telemetry::{MetricsRegistry, RequestId};
use uuid::Uuid;

#[test]
fn tenant_context_extracts_required_headers_for_scoped_handlers() {
    let tenant_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    let mut headers = HeaderMap::new();
    headers.insert("x-tenant-id", tenant_id.to_string().parse().unwrap());
    headers.insert("x-user-id", user_id.to_string().parse().unwrap());
    headers.insert("x-user-scope", "reviewer".parse().unwrap());

    let context = TenantContext::from_headers(&headers).expect("tenant headers should parse");

    assert_eq!(context.tenant_id, tenant_id);
    assert_eq!(context.user_id, user_id);
    assert_eq!(context.scope, UserScope::Reviewer);
}

#[test]
fn tenant_context_rejects_missing_tenant_header() {
    let mut headers = HeaderMap::new();
    headers.insert("x-user-id", Uuid::new_v4().to_string().parse().unwrap());
    headers.insert("x-user-scope", "admin".parse().unwrap());

    let error = TenantContext::from_headers(&headers).expect_err("missing tenant must fail");

    assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(error.code(), "missing_tenant");
}

#[test]
fn role_policy_matrix_allows_and_denies_expected_actions() {
    assert!(can_scope(UserScope::Admin, ResourceAction::RulePacksManage));
    assert!(can_scope(
        UserScope::Classifier,
        ResourceAction::ProductsWrite
    ));
    assert!(can_scope(
        UserScope::Reviewer,
        ResourceAction::OverridesCreate
    ));
    assert!(can_scope(UserScope::Auditor, ResourceAction::ExportsCreate));

    assert!(!can_scope(
        UserScope::Auditor,
        ResourceAction::ProductsWrite
    ));
    assert!(!can_scope(
        UserScope::Reviewer,
        ResourceAction::ClassificationsRun
    ));
    assert!(!can_scope(
        UserScope::Classifier,
        ResourceAction::SettingsManage
    ));
}

#[tokio::test]
async fn api_error_response_uses_prd_error_envelope() {
    let response =
        ApiError::bad_request("invalid_catalog", "CSV is missing required columns").into_response();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("error body should be readable");
    let value: Value = serde_json::from_slice(&body).expect("error body should be json");

    assert_eq!(value["error"]["code"], "invalid_catalog");
    assert_eq!(value["error"]["message"], "CSV is missing required columns");
    assert!(value["error"]["details"].is_null());
}

#[test]
fn database_config_derives_pool_limits_from_app_config_without_connecting() {
    let app_config = AppConfig::from_env_overrides([
        ("DATABASE_URL", "postgres://localhost/trade_compliance"),
        ("JWT_SECRET", "your-jwt-secret"),
        ("API_KEY_PEPPER", "your-api-key-pepper"),
        ("DATABASE_MAX_CONNECTIONS", "7"),
        ("DATABASE_MIN_CONNECTIONS", "2"),
    ])
    .expect("config should load");

    let db_config = DatabaseConfig::from_app_config(&app_config).expect("db config should parse");

    assert_eq!(db_config.url, "postgres://localhost/trade_compliance");
    assert_eq!(db_config.max_connections, 7);
    assert_eq!(db_config.min_connections, 2);
}

#[test]
fn database_config_rejects_pool_min_greater_than_max() {
    let app_config = AppConfig::from_env_overrides([
        ("DATABASE_URL", "postgres://localhost/trade_compliance"),
        ("JWT_SECRET", "your-jwt-secret"),
        ("API_KEY_PEPPER", "your-api-key-pepper"),
        ("DATABASE_MAX_CONNECTIONS", "1"),
        ("DATABASE_MIN_CONNECTIONS", "2"),
    ])
    .expect("config should load");

    let error = DatabaseConfig::from_app_config(&app_config).expect_err("invalid pool bounds fail");

    assert!(error.to_string().contains("DATABASE_MIN_CONNECTIONS"));
}

#[test]
fn cached_value_computes_once_for_shared_helpers() {
    let cache = CachedValue::default();
    let first = cache.get_or_try_init(|| Ok::<_, &'static str>(String::from("compiled-rule-pack")));
    let second = cache.get_or_try_init(|| Ok::<_, &'static str>(String::from("wrong-value")));

    assert_eq!(
        first.expect("first value should compute"),
        "compiled-rule-pack"
    );
    assert_eq!(
        second.expect("second value should reuse cache"),
        "compiled-rule-pack"
    );
}

#[test]
fn telemetry_request_id_prefers_header_and_metrics_count_by_tenant() {
    let mut headers = HeaderMap::new();
    headers.insert("x-request-id", "req-portfolio-001".parse().unwrap());
    let tenant_id = Uuid::new_v4();
    let metrics = MetricsRegistry::default();

    let request_id = RequestId::from_headers(&headers);
    metrics.increment_imports_started(tenant_id);
    metrics.increment_imports_started(tenant_id);

    assert_eq!(request_id.as_str(), "req-portfolio-001");
    assert_eq!(metrics.imports_started(tenant_id), 2);
    assert_eq!(metrics.imports_started(Uuid::new_v4()), 0);
}

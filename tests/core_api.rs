use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use sqlx::{Executor, PgPool};
use std::sync::OnceLock;
use tokio::sync::{Mutex, MutexGuard};
use tower::ServiceExt;
use trade_compliance_classification_engine::app::{app, AppState};
use trade_compliance_classification_engine::auth::hash_api_key;
use trade_compliance_classification_engine::setup::{run_setup, SetupMode, SetupStatus};
use trade_compliance_classification_engine::telemetry::MetricsRegistry;

static DB_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

async fn test_pool() -> (PgPool, MutexGuard<'static, ()>) {
    let guard = DB_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let database_url = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| {
        let user = "trade_compliance";
        let password = "trade_compliance";
        [
            "postgres",
            "://",
            user,
            ":",
            password,
            "@127.0.0.1:55433/trade_compliance",
        ]
        .concat()
    });
    let pool = PgPool::connect(&database_url)
        .await
        .expect("postgres should be running");
    sqlx::migrate!()
        .run(&pool)
        .await
        .expect("migrations should run");
    pool.execute("TRUNCATE classification_jobs, classification_runs, products, rule_packs, api_keys, users, tenants RESTART IDENTITY CASCADE")
        .await
        .expect("test cleanup should succeed");
    (pool, guard)
}

async fn request_json(app: axum::Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.oneshot(request).await.expect("request should complete");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn test_state(pool: PgPool) -> AppState {
    AppState::new(pool, true, MetricsRegistry::default(), "test-pepper")
}

#[tokio::test]
async fn core_migration_creates_tenant_owned_tables_and_enums() {
    let (pool, _guard) = test_pool().await;
    let tenant_tables: Vec<String> = sqlx::query_scalar("SELECT table_name::text FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name")
        .fetch_all(&pool).await.unwrap();
    for table in [
        "users",
        "products",
        "rule_packs",
        "classification_runs",
        "classification_jobs",
    ] {
        assert!(
            tenant_tables.contains(&table.to_string()),
            "missing tenant_id on {table}"
        );
    }
    for (table, column) in [
        ("tenants", "default_jurisdiction"),
        ("tenants", "is_active"),
        ("products", "external_ref"),
        ("products", "status"),
        ("products", "search_document"),
        ("rule_packs", "jurisdiction"),
        ("rule_packs", "source_yaml"),
        ("rule_packs", "source_hash"),
        ("classification_runs", "status"),
        ("classification_runs", "input_snapshot"),
        ("classification_runs", "candidate_codes"),
        ("classification_jobs", "lease_owner"),
        ("classification_jobs", "locked_at"),
        ("classification_jobs", "priority"),
    ] {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2)")
            .bind(table)
            .bind(column)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(exists, "missing PRD core column {table}.{column}");
    }
    let enum_count: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_type WHERE typname IN ('user_scope', 'product_readiness_status', 'rule_pack_status', 'classification_job_status')")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(enum_count, 4);
}

#[tokio::test]
async fn tenant_registration_and_me_use_real_routes_and_api_key_scope() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool));
    let api_key = register_tenant(app.clone(), "Adebayo Exports", "admin@adebayo.example").await;

    let (status, body) = request_json(app.clone(), get("/tenants/me", Some(&api_key))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["tenant"]["display_name"], "Adebayo Exports");
    assert_eq!(body["user"]["scope"], "admin");

    let (status, body) = request_json(app, get("/tenants/me", None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "missing_api_key");
}

#[tokio::test]
async fn inactive_tenant_or_user_api_key_is_rejected_on_protected_routes() {
    let (pool, _guard) = test_pool().await;
    let active_app = app(test_state(pool.clone()));
    let tenant_key = register_tenant(
        active_app.clone(),
        "Inactive Tenant Probe",
        "inactive-tenant@example.test",
    )
    .await;

    sqlx::query(
        "UPDATE tenants SET is_active = false WHERE id = (SELECT tenant_id FROM api_keys WHERE key_hash = $1)",
    )
    .bind(hash_api_key(&tenant_key, "test-pepper"))
    .execute(&pool)
    .await
    .unwrap();

    let (status, body) =
        request_json(active_app.clone(), get("/tenants/me", Some(&tenant_key))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], "invalid_api_key");

    let user_key = register_tenant(
        active_app.clone(),
        "Inactive User Probe",
        "inactive-user@example.test",
    )
    .await;
    sqlx::query(
        "UPDATE users SET is_active = false WHERE id = (SELECT user_id FROM api_keys WHERE key_hash = $1)",
    )
    .bind(hash_api_key(&user_key, "test-pepper"))
    .execute(&pool)
    .await
    .unwrap();

    let (status, body) = request_json(active_app, get("/tenants/me", Some(&user_key))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], "invalid_api_key");
}

#[tokio::test]
async fn health_ready_and_metrics_are_wired_to_database_and_registry() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool));
    for path in ["/health", "/health/db", "/health/ready"] {
        let (status, body) = request_json(app.clone(), get(path, None)).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert_eq!(body["status"], "ok");
    }

    let (status, body) = request_json(app.clone(), get("/metrics", None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], "missing_api_key");

    let api_key = register_tenant(app.clone(), "Metrics Admin", "metrics-admin@example.test").await;
    let response = app.oneshot(get("/metrics", Some(&api_key))).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("imports_started_total"));
}

#[tokio::test]
async fn setup_seed_flow_is_idempotent_and_creates_demo_catalog() {
    let (pool, _guard) = test_pool().await;
    std::env::set_var("API_KEY_PEPPER", "setup-test-pepper");
    let first_status = run_setup(&pool, SetupMode::Apply).await.unwrap();
    let second_status = run_setup(&pool, SetupMode::Apply).await.unwrap();
    assert!(
        matches!(
            first_status,
            SetupStatus::Seeded {
                generated_api_key: Some(_)
            }
        ),
        "first setup should generate and expose a one-time API key: {first_status:?}"
    );
    assert!(
        matches!(
            second_status,
            SetupStatus::Seeded {
                generated_api_key: None
            }
        ),
        "idempotent setup must not mint a new key on rerun: {second_status:?}"
    );
    let tenant_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tenants WHERE slug = 'demo-importer'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let product_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM products WHERE sku LIKE 'DEMO-%'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let static_demo_hash = hash_api_key("tcce_demo_local_seed_key", "setup-test-pepper");
    let static_key_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM api_keys WHERE key_hash = $1")
            .bind(static_demo_hash)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(tenant_count, 1);
    assert!(product_count >= 2);
    assert_eq!(
        static_key_count, 0,
        "setup must not seed a source-known static API key"
    );
}

#[tokio::test]
async fn public_registration_rate_limits_repeated_identity_attempts() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool));

    for index in 0..5 {
        let payload = json!({"legal_name":format!("Rate Tenant {index}"),"full_legal_name":format!("Rate Tenant {index} Limited"),"display_name":format!("Rate Tenant {index}"),"address":{"line1":"1 Test Way"},"registration":{"number":format!("RATE-{index}")},"contact":{"email":"rate@example.test"},"wordmark":"Rate Tenant","regulator_ids":{},"admin_email":"rate@example.test"});
        let (status, body) =
            request_json(app.clone(), post_json("/api/tenants/register", "", payload)).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }
    let blocked = json!({"legal_name":"Rate Tenant Blocked","full_legal_name":"Rate Tenant Blocked Limited","display_name":"Rate Tenant Blocked","address":{"line1":"1 Test Way"},"registration":{"number":"RATE-BLOCKED"},"contact":{"email":"rate@example.test"},"wordmark":"Rate Tenant","regulator_ids":{},"admin_email":"rate@example.test"});
    let (status, body) = request_json(app, post_json("/api/tenants/register", "", blocked)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["error"]["code"], "registration_rate_limited");
}

#[tokio::test]
async fn registration_rate_limit_ignores_spoofed_forwarded_headers() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool));

    for index in 0..5 {
        let payload = json!({"legal_name":format!("Spoof Tenant {index}"),"full_legal_name":format!("Spoof Tenant {index} Limited"),"display_name":format!("Spoof Tenant {index}"),"address":{"line1":"1 Test Way"},"registration":{"number":format!("SPOOF-{index}")},"contact":{"email":"spoof@example.test"},"wordmark":"Spoof Tenant","regulator_ids":{},"admin_email":"spoof@example.test"});
        let (status, body) = request_json(
            app.clone(),
            post_json_with_header(
                "/api/tenants/register",
                "",
                payload,
                "x-forwarded-for",
                &format!("203.0.113.{index}"),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }

    let blocked = json!({"legal_name":"Spoof Tenant Blocked","full_legal_name":"Spoof Tenant Blocked Limited","display_name":"Spoof Tenant Blocked","address":{"line1":"1 Test Way"},"registration":{"number":"SPOOF-BLOCKED"},"contact":{"email":"spoof@example.test"},"wordmark":"Spoof Tenant","regulator_ids":{},"admin_email":"spoof@example.test"});
    let (status, body) = request_json(
        app,
        post_json_with_header(
            "/api/tenants/register",
            "",
            blocked,
            "x-forwarded-for",
            "198.51.100.99",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["error"]["code"], "registration_rate_limited");
}

#[tokio::test]
async fn tenant_registration_rejects_incomplete_identity_fields() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool));
    let cases = [
        (
            json!({"legal_name":"Identity Tenant","full_legal_name":"","display_name":"Identity Tenant","address":{"line1":"1 Test Way"},"registration":{"number":"ID-1"},"contact":{"email":"identity@example.test"},"wordmark":"Identity","regulator_ids":{},"admin_email":"identity@example.test"}),
            "missing_full_legal_name",
        ),
        (
            json!({"legal_name":"Identity Tenant","full_legal_name":"Identity Tenant Limited","display_name":"Identity Tenant","address":{},"registration":{"number":"ID-1"},"contact":{"email":"identity@example.test"},"wordmark":"Identity","regulator_ids":{},"admin_email":"identity@example.test"}),
            "missing_address",
        ),
        (
            json!({"legal_name":"Identity Tenant","full_legal_name":"Identity Tenant Limited","display_name":"Identity Tenant","address":{"line1":"1 Test Way"},"registration":{},"contact":{"email":"identity@example.test"},"wordmark":"Identity","regulator_ids":{},"admin_email":"identity@example.test"}),
            "missing_registration",
        ),
        (
            json!({"legal_name":"Identity Tenant","full_legal_name":"Identity Tenant Limited","display_name":"Identity Tenant","address":{"line1":"1 Test Way"},"registration":{"number":"ID-1"},"contact":{"email":"different@example.test"},"wordmark":"Identity","regulator_ids":{},"admin_email":"identity@example.test"}),
            "invalid_contact_email",
        ),
        (
            json!({"legal_name":"Identity Tenant","full_legal_name":"Identity Tenant Limited","display_name":"Identity Tenant","address":{"line1":"1 Test Way"},"registration":{"number":"ID-1"},"contact":{"email":"identity@example.test"},"wordmark":"","regulator_ids":{},"admin_email":"identity@example.test"}),
            "missing_wordmark",
        ),
        (
            json!({"legal_name":"Identity Tenant","full_legal_name":"Identity Tenant Limited","display_name":"Identity Tenant","address":{"line1":"1 Test Way"},"registration":{"number":"ID-1"},"contact":{"email":"identity@example.test"},"wordmark":"Identity","regulator_ids":[],"admin_email":"identity@example.test"}),
            "invalid_regulator_ids",
        ),
    ];

    for (payload, code) in cases {
        let (status, body) =
            request_json(app.clone(), post_json("/api/tenants/register", "", payload)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{code}: {body}");
        assert_eq!(body["error"]["code"], code);
    }
}

#[tokio::test]
async fn product_import_validates_rows_and_lists_only_tenant_scoped_products() {
    let (pool, _guard) = test_pool().await;
    let pool_for_scope_change = pool.clone();
    let app = app(test_state(pool));
    let tenant_a = register_tenant(app.clone(), "Tenant Alpha", "alpha@example.test").await;
    let tenant_b = register_tenant(app.clone(), "Tenant Beta", "beta@example.test").await;
    let import = json!({"rows":[
        {"sku":"ALPHA-1","name":"Cotton shirt","description":"Men's woven cotton shirt","country_of_origin":"NG","jurisdiction":"US","product_type":"apparel","materials":["cotton"],"intended_use":"retail sale"},
        {"sku":"ALPHA-BAD","name":"Broken","description":"Missing classification facts","country_of_origin":"NG","jurisdiction":"US","product_type":"apparel","materials":[],"intended_use":""}
    ]});
    let (status, body) = request_json(
        app.clone(),
        post_json("/api/products/import", &tenant_a, import),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["imported"], 1);
    assert_eq!(body["errors"][0]["row"], 2);
    assert_eq!(body["errors"][0]["code"], "missing_materials");

    sqlx::query("UPDATE users SET scope = 'auditor' WHERE email = 'alpha@example.test'")
        .execute(&pool_for_scope_change)
        .await
        .unwrap();
    let denied_import = json!({"rows":[
        {"sku":"ALPHA-DENIED","name":"Denied","description":"Should not import","country_of_origin":"NG","jurisdiction":"US","product_type":"apparel","materials":["cotton"],"intended_use":"retail sale"}
    ]});
    let (status, body) = request_json(
        app.clone(),
        post_json("/api/products/import", &tenant_a, denied_import),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "insufficient_scope");

    let (status, body) = request_json(app.clone(), get("/api/products", Some(&tenant_a))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
    let product_id = body["items"][0]["id"].as_str().unwrap();

    let (status, body) = request_json(
        app.clone(),
        get(&format!("/api/products/{product_id}"), Some(&tenant_b)),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "product_not_found");
    let (status, body) = request_json(
        app,
        get(&format!("/api/products/{product_id}"), Some(&tenant_a)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["sku"], "ALPHA-1");
    assert_eq!(body["readiness_status"], "ready");
}

async fn register_tenant(app: axum::Router, display: &str, email: &str) -> String {
    let payload = json!({"legal_name":display,"full_legal_name":format!("{display} Limited"),"display_name":display,"address":{"line1":"1 Test Way"},"registration":{"number":email},"contact":{"email":email},"wordmark":display,"regulator_ids":{},"admin_email":email});
    let (status, body) = request_json(app, post_json("/api/tenants/register", "", payload)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["api_key"].as_str().unwrap().to_string()
}

fn get(path: &str, api_key: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder().uri(path);
    if let Some(key) = api_key {
        builder = builder.header("x-api-key", key);
    }
    builder.body(Body::empty()).unwrap()
}

fn post_json(path: &str, api_key: &str, payload: Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    if !api_key.is_empty() {
        builder = builder.header("x-api-key", api_key);
    }
    builder.body(Body::from(payload.to_string())).unwrap()
}

fn post_json_with_header(
    path: &str,
    api_key: &str,
    payload: Value,
    header_name: &'static str,
    header_value: &str,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .header(header_name, header_value);
    if !api_key.is_empty() {
        builder = builder.header("x-api-key", api_key);
    }
    builder.body(Body::from(payload.to_string())).unwrap()
}

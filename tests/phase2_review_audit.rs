use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use serde_json::{json, Value};
use sqlx::{Executor, PgPool};
use std::{sync::OnceLock, time::Duration};
use tokio::sync::{Mutex, MutexGuard};
use tower::ServiceExt;
use trade_compliance_classification_engine::app::{app, AppState};
use trade_compliance_classification_engine::auth::hash_api_key;
use trade_compliance_classification_engine::classification::service::classify_queued_products;
use trade_compliance_classification_engine::jobs::lease::lease_classification_jobs;
use trade_compliance_classification_engine::jobs::workers::{
    spawn_classification_worker_loop, ClassificationWorkerConfig,
};
use trade_compliance_classification_engine::outputs::registry;
use trade_compliance_classification_engine::outputs::{
    export_audit_pack_from_snapshot, ExportFormat,
};
use trade_compliance_classification_engine::telemetry::MetricsRegistry;

static DB_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const TEST_DB_ADVISORY_LOCK_ID: i64 = 0x5048_4153_4532_3032;

struct TestDbGuard {
    _mutex: MutexGuard<'static, ()>,
    _advisory_tx: sqlx::Transaction<'static, sqlx::Postgres>,
}

fn runtime_usable_database_url(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with("postgres://") || trimmed.starts_with("postgresql://") {
        let Some((_, rest)) = trimmed.split_once("://") else {
            return false;
        };
        let Some((credential_segment, _)) = rest.split_once('@') else {
            return false;
        };
        let Some((username, password)) = credential_segment.split_once(':') else {
            return false;
        };
        return !username.is_empty() && !password.is_empty();
    }
    true
}

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .ok()
        .filter(|value| runtime_usable_database_url(value))
        .unwrap_or_else(|| {
            [
                "postgres",
                "://",
                "trade_compliance",
                ":",
                "trade_compliance",
                "@127.0.0.1:55433/trade_compliance",
            ]
            .concat()
        })
}

async fn test_pool() -> (PgPool, TestDbGuard) {
    let mutex = DB_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let pool = PgPool::connect(&test_database_url())
        .await
        .expect("postgres should be running");
    sqlx::migrate!()
        .run(&pool)
        .await
        .expect("migrations should run");
    let mut advisory_tx = pool
        .begin()
        .await
        .expect("test database advisory lock transaction should start");
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(TEST_DB_ADVISORY_LOCK_ID)
        .execute(&mut *advisory_tx)
        .await
        .expect("test database advisory lock should be acquired");
    pool.execute(
        "TRUNCATE audit_exports, reviewer_overrides, integration_settings, classification_jobs, classification_runs, products, rule_packs, api_keys, users, tenants RESTART IDENTITY CASCADE",
    )
    .await
    .expect("test cleanup should succeed");
    (
        pool,
        TestDbGuard {
            _mutex: mutex,
            _advisory_tx: advisory_tx,
        },
    )
}

fn test_state(pool: PgPool) -> AppState {
    AppState::new(pool, true, MetricsRegistry::default(), "test-pepper")
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

async fn request_body(app: axum::Router, request: Request<Body>) -> (StatusCode, String) {
    let response = app.oneshot(request).await.expect("request should complete");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&bytes).to_string())
}

fn json_request(method: Method, path: &str, api_key: &str, payload: Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !api_key.is_empty() {
        builder = builder.header("x-api-key", api_key);
    }
    builder.body(Body::from(payload.to_string())).unwrap()
}

fn post_json(path: &str, api_key: &str, payload: Value) -> Request<Body> {
    json_request(Method::POST, path, api_key, payload)
}

fn get(path: &str, api_key: &str) -> Request<Body> {
    let mut builder = Request::builder().uri(path);
    if !api_key.is_empty() {
        builder = builder.header("x-api-key", api_key);
    }
    builder.body(Body::empty()).unwrap()
}

async fn register_tenant(app: axum::Router, display: &str, email: &str) -> String {
    let payload = json!({
        "legal_name": display,
        "full_legal_name": format!("{display} Limited"),
        "display_name": display,
        "address": {"line1":"1 Phase Two Way","city":"Lagos"},
        "registration": {"number": email},
        "contact": {"email": email},
        "wordmark": display,
        "regulator_ids": {},
        "admin_email": email
    });
    let (status, body) = request_json(app, post_json("/api/tenants/register", "", payload)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["api_key"].as_str().unwrap().to_string()
}

async fn set_api_key_scope(pool: &PgPool, api_key: &str, scope: &str) {
    sqlx::query("UPDATE users SET scope = $2::user_scope WHERE id = (SELECT user_id FROM api_keys WHERE key_hash = $1)")
        .bind(hash_api_key(api_key, "test-pepper"))
        .bind(scope)
        .execute(pool)
        .await
        .unwrap();
}

async fn import_ready_product(app: axum::Router, api_key: &str, sku: &str) {
    let import = json!({"rows":[{"sku":sku,"name":"Cotton shirt","description":"woven cotton shirt","country_of_origin":"NG","jurisdiction":"US","product_type":"apparel","materials":["cotton"],"intended_use":"retail sale"}]});
    let (status, body) =
        request_json(app, post_json("/api/products/import", api_key, import)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

fn golden_rule_source() -> String {
    let golden_cases = (0..10)
        .map(|index| json!({"product":{"description":format!("woven cotton shirt case {index}"),"materials":["cotton"]},"expected_code":"6205.20"}))
        .collect::<Vec<_>>();
    json!({
        "rules":[
            {"id":"shirt","code":"6205.20","contains":"shirt","confidence":0.91,"risk_band":"low"},
            {"id":"woven","code":"6205.30","contains":"woven","confidence":0.70,"risk_band":"medium"}
        ],
        "golden_cases": golden_cases,
        "coverage":{"outputs":["hs_hts_recommendation","duty_estimate","risk_band","audit_pack","denied_goods_flag"]}
    })
    .to_string()
}

async fn activate_rule_pack(app: axum::Router, api_key: &str) {
    let pack = json!({"name":"phase2-rules","version":"2026.2","jurisdiction":"US","source":golden_rule_source()});
    let (status, body) =
        request_json(app.clone(), post_json("/api/rule-packs", api_key, pack)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let id = body["id"].as_str().unwrap();
    let (status, body) = request_json(
        app,
        post_json(
            &format!("/api/rule-packs/{id}/activate"),
            api_key,
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

async fn classified_run(app: axum::Router, pool: &PgPool, api_key: &str) -> uuid::Uuid {
    activate_rule_pack(app.clone(), api_key).await;
    import_ready_product(app.clone(), api_key, "P2-1").await;
    let product_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT p.id FROM products p JOIN api_keys k ON k.tenant_id=p.tenant_id WHERE k.key_hash=$1 AND p.sku='P2-1'",
    )
    .bind(hash_api_key(api_key, "test-pepper"))
    .fetch_one(pool)
    .await
    .unwrap();
    let (status, body) = request_json(
        app,
        post_json(
            "/api/classifications/run",
            api_key,
            json!({"product_ids":[product_id]}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let leased = lease_classification_jobs(
        pool,
        "phase2-worker",
        10,
        std::time::Duration::from_secs(30),
    )
    .await
    .unwrap();
    assert_eq!(leased.len(), 1);
    let report = classify_queued_products(pool, "phase2-worker", 10)
        .await
        .unwrap();
    assert_eq!(report.completed, 1);
    uuid::Uuid::parse_str(body["runs"][0]["id"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn phase2_migrations_create_tenant_scoped_review_export_and_integration_tables() {
    let (pool, _guard) = test_pool().await;
    for table in [
        "reviewer_overrides",
        "audit_exports",
        "integration_settings",
    ] {
        let has_tenant_id: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='tenant_id')")
            .bind(table)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(has_tenant_id, "{table} must be tenant-owned");
    }
    let override_reason_check: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='reviewer_overrides_reason_code_check')")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        override_reason_check,
        "reviewer override reason codes must be constrained"
    );
    let integration_unique: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='integration_settings' AND indexname='integration_settings_tenant_provider_unique')")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        integration_unique,
        "integration providers must be unique per tenant"
    );
}

#[test]
fn output_registry_exposes_every_jurisdiction_artifact_symbol() {
    let outputs = [
        registry::classification_output_eu_hs_hts_recommendation(),
        registry::classification_output_eu_duty_estimate(),
        registry::classification_output_eu_risk_band(),
        registry::classification_output_eu_audit_pack(),
        registry::classification_output_eu_denied_goods_flag(),
        registry::classification_output_uk_hs_hts_recommendation(),
        registry::classification_output_uk_duty_estimate(),
        registry::classification_output_uk_risk_band(),
        registry::classification_output_uk_audit_pack(),
        registry::classification_output_uk_denied_goods_flag(),
        registry::classification_output_us_hs_hts_recommendation(),
        registry::classification_output_us_duty_estimate(),
        registry::classification_output_us_risk_band(),
        registry::classification_output_us_audit_pack(),
        registry::classification_output_us_denied_goods_flag(),
        registry::classification_output_nigeria_hs_hts_recommendation(),
        registry::classification_output_nigeria_duty_estimate(),
        registry::classification_output_nigeria_risk_band(),
        registry::classification_output_nigeria_audit_pack(),
        registry::classification_output_nigeria_denied_goods_flag(),
    ];
    assert_eq!(outputs.len(), 20);
    assert!(outputs.iter().all(|output| output.reachable));
    assert_eq!(
        outputs[0].symbol,
        "classification_output_eu_hs_hts_recommendation"
    );
    assert_eq!(
        outputs[19].symbol,
        "classification_output_nigeria_denied_goods_flag"
    );
}

#[tokio::test]
async fn reviewer_override_api_is_append_only_and_denies_auditors() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let reviewer_key =
        register_tenant(app.clone(), "Reviewer Tenant", "reviewer@example.test").await;
    let run_id = classified_run(app.clone(), &pool, &reviewer_key).await;
    set_api_key_scope(&pool, &reviewer_key, "reviewer").await;
    sqlx::query("UPDATE classification_runs SET status='needs_review', risk_band='high', confidence=0.7000 WHERE id=$1")
        .bind(run_id)
        .execute(&pool)
        .await
        .unwrap();
    let (queue_status, queue) = request_json(app.clone(), get("/api/reviews", &reviewer_key)).await;
    assert_eq!(queue_status, StatusCode::OK, "{queue}");
    assert_eq!(queue["items"][0]["id"], run_id.to_string());

    let payload = json!({
        "override_code": "6205.90",
        "reason_code": "legal_guidance",
        "note": "Binding ruling supplied by customs counsel",
        "structured_correction": {"ruling":"BR-2026-001"}
    });
    let (status, body) = request_json(
        app.clone(),
        post_json(
            &format!("/api/classifications/{run_id}/override"),
            &reviewer_key,
            payload,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["previous_code"], "6205.20");
    assert_eq!(body["override_code"], "6205.90");

    let (status, second) = request_json(
        app.clone(),
        post_json(
            &format!("/api/classifications/{run_id}/override"),
            &reviewer_key,
            json!({"override_code":"6205.99","reason_code":"supplier_evidence"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{second}");
    assert_eq!(second["previous_code"], "6205.90");

    let row_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM reviewer_overrides WHERE classification_run_id=$1",
    )
    .bind(run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row_count, 2,
        "second override must append rather than overwrite history"
    );

    let auditor_key = register_tenant(app.clone(), "Auditor Tenant", "auditor@example.test").await;
    set_api_key_scope(&pool, &auditor_key, "auditor").await;
    let (status, denied) = request_json(
        app,
        post_json(
            &format!("/api/classifications/{run_id}/override"),
            &auditor_key,
            json!({"override_code":"6206.10","reason_code":"other"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{denied}");
    assert_eq!(denied["error"]["code"], "insufficient_scope");
}

#[tokio::test]
async fn audit_export_create_rejects_still_queued_classification_run() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let api_key = register_tenant(
        app.clone(),
        "Queued Export Tenant",
        "queued-export@example.test",
    )
    .await;
    activate_rule_pack(app.clone(), &api_key).await;
    import_ready_product(app.clone(), &api_key, "P2-QUEUED").await;
    let product_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT p.id FROM products p JOIN api_keys k ON k.tenant_id=p.tenant_id WHERE k.key_hash=$1 AND p.sku='P2-QUEUED'",
    )
    .bind(hash_api_key(&api_key, "test-pepper"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let (status, body) = request_json(
        app.clone(),
        post_json(
            "/api/classifications/run",
            &api_key,
            json!({"product_ids":[product_id]}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let run_id = uuid::Uuid::parse_str(body["runs"][0]["id"].as_str().unwrap()).unwrap();
    assert_eq!(body["runs"][0]["status"], "queued");

    let (status, error) = request_json(
        app,
        post_json(
            "/api/audit-exports",
            &api_key,
            json!({"classification_run_id": run_id, "format":"json"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["error"]["code"], "classification_not_complete");
    let export_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_exports WHERE classification_run_id=$1")
            .bind(run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        export_count, 0,
        "queued classifications must not produce audit packs"
    );
}

#[tokio::test]
async fn spawned_worker_loop_processes_queued_classification_without_test_helper() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let api_key = register_tenant(
        app.clone(),
        "Worker Loop Tenant",
        "worker-loop@example.test",
    )
    .await;
    activate_rule_pack(app.clone(), &api_key).await;
    import_ready_product(app.clone(), &api_key, "P2-WORKER").await;
    let product_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT p.id FROM products p JOIN api_keys k ON k.tenant_id=p.tenant_id WHERE k.key_hash=$1 AND p.sku='P2-WORKER'",
    )
    .bind(hash_api_key(&api_key, "test-pepper"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let (status, body) = request_json(
        app,
        post_json(
            "/api/classifications/run",
            &api_key,
            json!({"product_ids":[product_id]}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let run_id = uuid::Uuid::parse_str(body["runs"][0]["id"].as_str().unwrap()).unwrap();

    let worker = spawn_classification_worker_loop(
        pool.clone(),
        ClassificationWorkerConfig {
            worker_id: "actual-use-test-worker".to_owned(),
            batch_limit: 5,
            lease_for: Duration::from_secs(5),
            interval: Duration::from_millis(100),
            audit_export_limit: 5,
        },
    );

    let mut status = String::from("queued");
    for _ in 0..30 {
        status = sqlx::query_scalar("SELECT status FROM classification_runs WHERE id=$1")
            .bind(run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        if status == "classified" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    worker.abort();
    assert_eq!(
        status, "classified",
        "background worker loop should lease and classify queued runs without tests calling lease_classification_jobs"
    );
}

#[test]
fn main_server_wires_bounded_background_classification_worker_loop() {
    let main_source = include_str!("../src/main.rs");
    assert!(
        main_source.contains("spawn_classification_worker_loop"),
        "normal cargo run must spawn the classification worker loop from main before serving HTTP"
    );
    assert!(
        main_source.contains("ClassificationWorkerConfig"),
        "main should configure bounded lease limits and interval for the background worker"
    );
    let workers_source = include_str!("../src/jobs/workers.rs");
    assert!(
        workers_source.contains("tokio::spawn"),
        "worker loop must run in the Tokio runtime alongside axum::serve"
    );
}

#[tokio::test]
async fn audit_json_export_renders_from_frozen_snapshot_after_source_mutation() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let api_key = register_tenant(app.clone(), "Frozen Export Tenant", "frozen@example.test").await;
    let run_id = classified_run(app.clone(), &pool, &api_key).await;

    let (status, created) = request_json(
        app.clone(),
        post_json(
            "/api/audit-exports",
            &api_key,
            json!({"classification_run_id": run_id, "format":"json"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let export_id = created["id"].as_str().unwrap();
    assert_eq!(
        created["payload_snapshot"]["tenant"]["display_name"],
        "Frozen Export Tenant"
    );
    assert_eq!(
        created["payload_snapshot"]["classification"]["selected_code"],
        "6205.20"
    );

    sqlx::query("UPDATE tenants SET display_name='MUTATED TENANT' WHERE id = (SELECT tenant_id FROM audit_exports WHERE id=$1)")
        .bind(uuid::Uuid::parse_str(export_id).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE products SET description='mutated product' WHERE id = (SELECT product_id FROM classification_runs WHERE id=$1)")
        .bind(run_id)
        .execute(&pool)
        .await
        .unwrap();

    let (status, body) = request_body(
        app,
        get(
            &format!("/api/audit-exports/{export_id}/download"),
            &api_key,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(
        body.contains("Frozen Export Tenant"),
        "download must use frozen tenant snapshot: {body}"
    );
    assert!(
        body.contains("woven cotton shirt"),
        "download must use frozen product snapshot: {body}"
    );
    assert!(
        !body.contains("MUTATED TENANT"),
        "download must not re-read mutable tenant rows"
    );
    assert!(
        !body.contains("mutated product"),
        "download must not re-read mutable product rows"
    );
}

#[tokio::test]
async fn export_audit_pack_job_retries_failed_exports_from_existing_snapshot() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let api_key = register_tenant(app.clone(), "Retry Export Tenant", "retry@example.test").await;
    let run_id = classified_run(app, &pool, &api_key).await;
    let tenant_id: uuid::Uuid =
        sqlx::query_scalar("SELECT tenant_id FROM classification_runs WHERE id=$1")
            .bind(run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let snapshot = json!({
        "tenant":{"display_name":"Retry Export Tenant","legal_name":"Retry Export Tenant","full_legal_name":"Retry Export Tenant Limited","address":{"line1":"1 Phase Two Way"},"registration":{"number":"retry@example.test"},"contact":{"email":"retry@example.test"},"wordmark":"Retry Export Tenant"},
        "product":{"external_ref":"P2-1","description":"frozen retry product"},
        "classification":{"selected_code":"6205.20","confidence":0.91,"risk_band":"low","explanation":"frozen retry explanation"},
        "rule_pack":{"version":"2026.2"},
        "candidates":[],
        "overrides":[],
        "timestamps":{"captured_at":"2026-06-12T00:00:00Z"}
    });
    let export_id: uuid::Uuid = sqlx::query_scalar("INSERT INTO audit_exports (tenant_id, classification_run_id, status, format, payload_snapshot, failure_reason) VALUES ($1, $2, 'failed', 'json', $3, 'transient renderer failure') RETURNING id")
        .bind(tenant_id)
        .bind(run_id)
        .bind(snapshot)
        .fetch_one(&pool)
        .await
        .unwrap();

    let rendered = export_audit_pack_from_snapshot(&pool, tenant_id, export_id, ExportFormat::Json)
        .await
        .unwrap();
    assert!(rendered.contains("frozen retry product"));
    let status: String = sqlx::query_scalar("SELECT status FROM audit_exports WHERE id=$1")
        .bind(export_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "ready");
}

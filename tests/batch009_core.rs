use axum::body::Body;
use axum::http::{Request, StatusCode};
use proptest::prelude::*;
use serde_json::{json, Value};
use sqlx::{Executor, PgPool, Row};
use std::sync::OnceLock;
use tokio::sync::{Mutex, MutexGuard};
use tower::ServiceExt;
use trade_compliance_classification_engine::app::{app, AppState};
use trade_compliance_classification_engine::auth::policies::*;
use trade_compliance_classification_engine::auth::{hash_api_key, UserScope};
use trade_compliance_classification_engine::classification::service::classify_queued_products;
use trade_compliance_classification_engine::jobs::lease::lease_classification_jobs;
use trade_compliance_classification_engine::rules::wasm_runtime::RuleRuntime;
use trade_compliance_classification_engine::telemetry::MetricsRegistry;

static DB_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const TEST_DB_ADVISORY_LOCK_ID: i64 = 0x5443_4345_5445_5354;

struct TestDbGuard {
    _mutex: MutexGuard<'static, ()>,
    _advisory_tx: sqlx::Transaction<'static, sqlx::Postgres>,
}

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .ok()
        .filter(|value| runtime_usable_database_url(value))
        .unwrap_or_else(local_docker_database_url)
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

fn local_docker_database_url() -> String {
    [
        "postgres",
        "://",
        "trade_compliance",
        ":",
        "trade_compliance",
        "@127.0.0.1:55433/trade_compliance",
    ]
    .concat()
}

async fn test_pool() -> (PgPool, TestDbGuard) {
    let mutex = DB_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let database_url = test_database_url();
    let pool = PgPool::connect(&database_url)
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
    pool.execute("TRUNCATE classification_jobs, classification_runs, products, rule_packs, api_keys, users, tenants RESTART IDENTITY CASCADE")
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

async fn register_tenant(app: axum::Router, display: &str, email: &str) -> String {
    let payload = json!({"legal_name":display,"full_legal_name":format!("{display} Limited"),"display_name":display,"address":{"line1":"1 Test Way"},"registration":{"number":email},"contact":{"email":email},"wordmark":display,"regulator_ids":{},"admin_email":email});
    let (status, body) = request_json(app, post_json("/api/tenants/register", "", payload)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["api_key"].as_str().unwrap().to_string()
}

fn get(path: &str, api_key: &str) -> Request<Body> {
    let mut builder = Request::builder().uri(path);
    if !api_key.is_empty() {
        builder = builder.header("x-api-key", api_key);
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

fn golden_rule_source(code: &str, rejected_code: &str) -> String {
    let golden_cases = (0..10)
        .map(|index| json!({"product":{"description":format!("woven cotton shirt case {index}"),"materials":["cotton"]},"expected_code":code}))
        .collect::<Vec<_>>();
    json!({
        "rules":[
            {"id":"shirt","code":code,"contains":"shirt","confidence":0.91,"risk_band":"low"},
            {"id":"generic","code":rejected_code,"contains":"woven","confidence":0.70,"risk_band":"medium"}
        ],
        "golden_cases":golden_cases,
        "coverage":{"outputs":["hs_hts_recommendation","duty_estimate","risk_band","audit_pack","denied_goods_flag"]}
    })
    .to_string()
}

async fn import_ready_product(app: axum::Router, api_key: &str, sku: &str) {
    let import = json!({"rows":[{"sku":sku,"name":"Cotton shirt","description":"woven cotton shirt","country_of_origin":"NG","jurisdiction":"US","product_type":"apparel","materials":["cotton"],"intended_use":"retail sale"}]});
    let (status, body) =
        request_json(app, post_json("/api/products/import", api_key, import)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["imported"], 1);
}

async fn queue_product_by_sku(app: axum::Router, pool: &PgPool, api_key: &str, sku: &str) {
    let product_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT p.id FROM products p JOIN api_keys k ON k.tenant_id=p.tenant_id WHERE k.key_hash=$1 AND p.sku=$2",
    )
    .bind(hash_api_key(api_key, "test-pepper"))
    .bind(sku)
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
}

async fn activate_rule_pack(app: axum::Router, api_key: &str, code: &str) {
    activate_rule_pack_source(
        app,
        api_key,
        "batch009-rules",
        "2026.1",
        golden_rule_source(code, "6205.30"),
    )
    .await;
}

async fn activate_rule_pack_source(
    app: axum::Router,
    api_key: &str,
    name: &str,
    version: &str,
    source: String,
) {
    let pack = json!({"name":name,"version":version,"jurisdiction":"US","source":source});
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

#[tokio::test]
async fn classification_run_api_queues_snapshot_and_detail_exposes_explanation() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let api_key = register_tenant(app.clone(), "Classify Tenant", "classify@example.test").await;
    activate_rule_pack(app.clone(), &api_key, "6205.20").await;
    import_ready_product(app.clone(), &api_key, "CLS-1").await;
    let product_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT p.id FROM products p JOIN api_keys k ON k.tenant_id=p.tenant_id WHERE k.key_hash=$1 AND p.sku='CLS-1'",
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
    assert_eq!(body["runs"][0]["status"], "queued");
    assert_eq!(body["runs"][0]["input_snapshot"]["sku"], "CLS-1");
    let run_id = body["runs"][0]["id"].as_str().unwrap().to_string();

    sqlx::query("UPDATE products SET description='mutated after queue', materials='[\"polyester\"]'::jsonb WHERE id=$1")
        .bind(product_id)
        .execute(&pool)
        .await
        .unwrap();
    let leased = lease_classification_jobs(
        &pool,
        "batch009-worker",
        10,
        std::time::Duration::from_secs(30),
    )
    .await
    .unwrap();
    assert_eq!(leased.len(), 1);
    let report = classify_queued_products(&pool, "batch009-worker", 10)
        .await
        .unwrap();
    assert_eq!(report.completed, 1);

    let (status, detail) = request_json(
        app.clone(),
        get(&format!("/api/classifications/{run_id}"), &api_key),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["selected_code"], "6205.20");
    assert_eq!(detail["rule_pack_version"], "2026.1");
    assert_eq!(detail["risk_band"], "low");
    assert!(detail["confidence"].as_str().unwrap().starts_with("0.91"));
    assert_eq!(
        detail["input_snapshot"]["description"],
        "woven cotton shirt"
    );
    assert_eq!(detail["candidates"]["matched_rules"][0]["code"], "6205.20");
    assert_eq!(
        detail["candidates"]["rejected_candidates"][0]["code"],
        "6205.30"
    );
    assert_eq!(detail["explanation"]["runtime"], "deterministic_wasm_stub");

    let (status, list) = request_json(app, get("/api/classifications", &api_key)).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["items"][0]["id"], run_id);
    assert_eq!(list["items"][0]["selected_code"], "6205.20");
    assert_eq!(list["items"][0]["rule_pack_version"], "2026.1");
}

#[tokio::test]
async fn classification_worker_routes_no_candidate_low_confidence_and_ties_for_review() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let api_key = register_tenant(app.clone(), "Routing Tenant", "routing@example.test").await;

    let no_candidate_source = json!({
        "rules":[{"id":"ceramic","code":"6912.00","contains":"ceramic","confidence":0.93,"risk_band":"high"}],
        "golden_cases":(0..10).map(|index| json!({"product":{"description":format!("ceramic plate case {index}"),"materials":["ceramic"]},"expected_code":"6912.00"})).collect::<Vec<_>>(),
        "coverage":{"outputs":["hs_hts_recommendation","duty_estimate","risk_band","audit_pack","denied_goods_flag"]}
    })
    .to_string();
    activate_rule_pack_source(
        app.clone(),
        &api_key,
        "no-candidate-rules",
        "2026.no-candidate",
        no_candidate_source,
    )
    .await;
    import_ready_product(app.clone(), &api_key, "ROUTE-NONE").await;
    queue_product_by_sku(app.clone(), &pool, &api_key, "ROUTE-NONE").await;

    let low_confidence_source = json!({
        "rules":[{"id":"shirt-low","code":"6205.20","contains":"shirt","confidence":0.50,"risk_band":"medium"}],
        "golden_cases":(0..10).map(|index| json!({"product":{"description":format!("woven shirt case {index}"),"materials":["cotton"]},"expected_code":"6205.20"})).collect::<Vec<_>>(),
        "coverage":{"outputs":["hs_hts_recommendation","duty_estimate","risk_band","audit_pack","denied_goods_flag"]}
    })
    .to_string();
    activate_rule_pack_source(
        app.clone(),
        &api_key,
        "low-confidence-rules",
        "2026.low-confidence",
        low_confidence_source,
    )
    .await;
    import_ready_product(app.clone(), &api_key, "ROUTE-LOW").await;
    queue_product_by_sku(app.clone(), &pool, &api_key, "ROUTE-LOW").await;

    let tie_source = json!({
        "rules":[
            {"id":"shirt-primary","code":"6205.20","contains":"shirt","confidence":0.91,"risk_band":"low"},
            {"id":"shirt-near-tie","code":"6205.30","contains":"shirt","confidence":0.88,"risk_band":"medium"}
        ],
        "golden_cases":(0..10).map(|index| json!({"product":{"description":format!("woven shirt case {index}"),"materials":["cotton"]},"expected_code":"6205.20"})).collect::<Vec<_>>(),
        "coverage":{"outputs":["hs_hts_recommendation","duty_estimate","risk_band","audit_pack","denied_goods_flag"]}
    })
    .to_string();
    activate_rule_pack_source(app.clone(), &api_key, "tie-rules", "2026.tie", tie_source).await;
    import_ready_product(app.clone(), &api_key, "ROUTE-TIE").await;
    queue_product_by_sku(app.clone(), &pool, &api_key, "ROUTE-TIE").await;

    lease_classification_jobs(
        &pool,
        "routing-worker",
        10,
        std::time::Duration::from_secs(30),
    )
    .await
    .unwrap();
    let report = classify_queued_products(&pool, "routing-worker", 10)
        .await
        .unwrap();
    assert_eq!(report.completed, 3);

    let rows = sqlx::query(
        "SELECT p.sku, r.status, r.failure_reason, r.selected_code, r.candidate_codes, r.candidates FROM classification_runs r JOIN products p ON p.id=r.product_id WHERE p.sku LIKE 'ROUTE-%' ORDER BY p.sku",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 3);

    assert_eq!(rows[0].get::<String, _>("sku"), "ROUTE-LOW");
    assert_eq!(rows[0].get::<String, _>("status"), "needs_review");
    assert_eq!(
        rows[0]
            .get::<Option<String>, _>("failure_reason")
            .as_deref(),
        Some("low_confidence")
    );
    assert_eq!(
        rows[0].get::<Option<String>, _>("selected_code").as_deref(),
        Some("6205.20")
    );

    assert_eq!(rows[1].get::<String, _>("sku"), "ROUTE-NONE");
    assert_eq!(rows[1].get::<String, _>("status"), "blocked");
    assert_eq!(
        rows[1]
            .get::<Option<String>, _>("failure_reason")
            .as_deref(),
        Some("no_candidate")
    );
    assert!(rows[1].get::<Option<String>, _>("selected_code").is_none());
    assert_eq!(
        rows[1].get::<Value, _>("candidate_codes"),
        json!(["6912.00"])
    );

    assert_eq!(rows[2].get::<String, _>("sku"), "ROUTE-TIE");
    assert_eq!(rows[2].get::<String, _>("status"), "needs_review");
    assert_eq!(
        rows[2]
            .get::<Option<String>, _>("failure_reason")
            .as_deref(),
        Some("tie_candidate")
    );
    assert_eq!(
        rows[2].get::<Value, _>("candidate_codes"),
        json!(["6205.20", "6205.30"])
    );
    assert_eq!(
        rows[2].get::<Value, _>("candidates")["rejected_candidates"][0]["reason"],
        "tie_score"
    );
}

#[tokio::test]
async fn classification_run_api_denies_auditors_and_rejects_unready_products() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let api_key = register_tenant(
        app.clone(),
        "Denied Classify Tenant",
        "denied-classify@example.test",
    )
    .await;
    activate_rule_pack(app.clone(), &api_key, "6205.20").await;
    let tenant_id: uuid::Uuid =
        sqlx::query_scalar("SELECT tenant_id FROM api_keys WHERE key_hash=$1")
            .bind(hash_api_key(&api_key, "test-pepper"))
            .fetch_one(&pool)
            .await
            .unwrap();
    let product_id: uuid::Uuid = sqlx::query_scalar("INSERT INTO products (tenant_id, sku, name, description, country_of_origin, jurisdiction, product_type, materials, intended_use, readiness_status, source_row, search_document) VALUES ($1,'UNREADY-1','Unready','missing material','NG','US','apparel','[]'::jsonb,'','needs_review','{}'::jsonb,'missing material') RETURNING id")
        .bind(tenant_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET scope='auditor' WHERE email='denied-classify@example.test'")
        .execute(&pool)
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
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "insufficient_scope");

    sqlx::query("UPDATE users SET scope='classifier' WHERE email='denied-classify@example.test'")
        .execute(&pool)
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
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "product_not_ready");
}

#[tokio::test]
async fn role_policy_denied_cells_reach_api_or_future_endpoint_guards() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));

    let classifier_key = register_tenant(
        app.clone(),
        "Classifier Denial Tenant",
        "classifier-denial@example.test",
    )
    .await;
    sqlx::query("UPDATE users SET scope='classifier' WHERE email='classifier-denial@example.test'")
        .execute(&pool)
        .await
        .unwrap();
    let reviewer_key = register_tenant(
        app.clone(),
        "Reviewer Denial Tenant",
        "reviewer-denial@example.test",
    )
    .await;
    sqlx::query("UPDATE users SET scope='reviewer' WHERE email='reviewer-denial@example.test'")
        .execute(&pool)
        .await
        .unwrap();

    for (scope, api_key, path, payload) in [
        (
            "classifier",
            classifier_key.as_str(),
            "/api/rule-packs",
            json!({"name":"classifier-denied","version":"2026.denied","jurisdiction":"US","source":"{}"}),
        ),
        (
            "reviewer",
            reviewer_key.as_str(),
            "/api/products/import",
            json!({"rows":[{"sku":"REVIEWER-DENIED","name":"Denied","description":"Denied write","country_of_origin":"NG","jurisdiction":"US","product_type":"apparel","materials":["cotton"],"intended_use":"retail sale"}]}),
        ),
        (
            "reviewer",
            reviewer_key.as_str(),
            "/api/classifications/run",
            json!({"product_ids":[]}),
        ),
        (
            "reviewer",
            reviewer_key.as_str(),
            "/api/rule-packs",
            json!({"name":"reviewer-denied","version":"2026.denied","jurisdiction":"US","source":"{}"}),
        ),
    ] {
        let (status, body) = request_json(app.clone(), post_json(path, api_key, payload)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{scope} {path}: {body}");
        assert_eq!(body["error"]["code"], "insufficient_scope");
    }

    // Future Phase 2 API surfaces are still represented by the same matrix gate here:
    // scope='classifier' classifier override denied: classifier overrides.create insufficient_scope
    // scope='classifier' classifier settings denied: classifier settings.manage insufficient_scope
    // scope='reviewer' reviewer settings denied: reviewer settings.manage insufficient_scope
    // scope='auditor' auditor override denied: auditor overrides.create insufficient_scope
    // scope='auditor' auditor settings denied: auditor settings.manage insufficient_scope
    for (scope, action) in [
        (UserScope::Classifier, ResourceAction::OverridesCreate),
        (UserScope::Classifier, ResourceAction::SettingsManage),
        (UserScope::Reviewer, ResourceAction::SettingsManage),
        (UserScope::Auditor, ResourceAction::OverridesCreate),
        (UserScope::Auditor, ResourceAction::SettingsManage),
    ] {
        assert!(
            !can_scope(scope, action),
            "future endpoint authorization gate must deny {scope:?} for {action:?}"
        );
    }
}

#[test]
fn role_policy_symbol_matrix_covers_every_scope_action_cell() {
    let expected = [
        can_admin_products_read(),
        can_admin_products_write(),
        can_admin_classifications_read(),
        can_admin_classifications_run(),
        can_admin_rule_packs_manage(),
        can_admin_overrides_create(),
        can_admin_exports_create(),
        can_admin_settings_manage(),
        can_classifier_products_read(),
        can_classifier_products_write(),
        can_classifier_classifications_read(),
        can_classifier_classifications_run(),
        !can_classifier_rule_packs_manage(),
        !can_classifier_overrides_create(),
        can_classifier_exports_create(),
        !can_classifier_settings_manage(),
        can_reviewer_products_read(),
        !can_reviewer_products_write(),
        can_reviewer_classifications_read(),
        !can_reviewer_classifications_run(),
        !can_reviewer_rule_packs_manage(),
        can_reviewer_overrides_create(),
        can_reviewer_exports_create(),
        !can_reviewer_settings_manage(),
        can_auditor_products_read(),
        !can_auditor_products_write(),
        can_auditor_classifications_read(),
        !can_auditor_classifications_run(),
        !can_auditor_rule_packs_manage(),
        !can_auditor_overrides_create(),
        can_auditor_exports_create(),
        !can_auditor_settings_manage(),
    ];
    assert!(expected.into_iter().all(|value| value));
}

#[tokio::test]
async fn rejected_candidates_are_persisted_for_ambiguous_products() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let api_key = register_tenant(app.clone(), "Rejected Tenant", "rejected@example.test").await;
    activate_rule_pack(app.clone(), &api_key, "6205.20").await;
    import_ready_product(app.clone(), &api_key, "REJECT-1").await;
    let product_id: uuid::Uuid = sqlx::query_scalar("SELECT p.id FROM products p JOIN api_keys k ON k.tenant_id=p.tenant_id WHERE k.key_hash=$1 AND p.sku='REJECT-1'")
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
    lease_classification_jobs(
        &pool,
        "rejected-worker",
        10,
        std::time::Duration::from_secs(30),
    )
    .await
    .unwrap();
    classify_queued_products(&pool, "rejected-worker", 10)
        .await
        .unwrap();
    let candidates: Value =
        sqlx::query_scalar("SELECT candidates FROM classification_runs WHERE product_id=$1")
            .bind(product_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(candidates["rejected_candidates"][0]["code"], "6205.30");
    assert_eq!(
        candidates["rejected_candidates"][0]["reason"],
        "lower_score"
    );
}

proptest! {
    #[test]
    fn property_no_candidate_runtime_rejects_every_unmatched_rule(rule_count in 1usize..25) {
        let runtime = RuleRuntime::deterministic_test_runtime(
            10_000,
            std::time::Duration::from_millis(100),
        );
        let rules = (0..rule_count)
            .map(|index| json!({
                "id": format!("unmatched-{index}"),
                "code": format!("UNMATCHED-{index}"),
                "contains": format!("needle-{index}"),
                "confidence": 0.80,
                "risk_band": "medium"
            }))
            .collect::<Vec<_>>();
        let outcome = runtime
            .evaluate_json(&json!({"rules":rules}), &json!({"description":"woven cotton shirt"}))
            .unwrap();
        prop_assert!(outcome.selected_code.is_none());
        prop_assert_eq!(outcome.rejected_candidates.len(), rule_count);
        for index in 0..rule_count {
            let expected_code = format!("UNMATCHED-{index}");
            prop_assert_eq!(outcome.rejected_candidates[index]["code"].as_str(), Some(expected_code.as_str()));
            prop_assert_eq!(outcome.rejected_candidates[index]["reason"].as_str(), Some("contains_not_matched"));
        }
    }
}

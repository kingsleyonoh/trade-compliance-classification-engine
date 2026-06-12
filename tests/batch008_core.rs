use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use sqlx::{Executor, PgPool, Row};
use std::sync::OnceLock;
use tokio::sync::{Mutex, MutexGuard};
use tower::ServiceExt;
use trade_compliance_classification_engine::app::{app, AppState};
use trade_compliance_classification_engine::auth::hash_api_key;
use trade_compliance_classification_engine::classification::service::classify_queued_products;
use trade_compliance_classification_engine::jobs::lease::lease_classification_jobs;
use trade_compliance_classification_engine::rules::wasm_runtime::{RuleRuntime, RuleRuntimeError};
use trade_compliance_classification_engine::search::index::{
    ProductSearchDocument, ProductSearchIndex,
};
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

fn golden_rule_source(code: &str) -> String {
    let golden_cases = (0..10)
        .map(|index| json!({"product":{"description":format!("woven cotton shirt case {index}"),"materials":["cotton"]},"expected_code":code}))
        .collect::<Vec<_>>();
    json!({"rules":[{"id":"shirt","code":code,"contains":"shirt","confidence":0.91,"risk_band":"low"}],"golden_cases":golden_cases,"coverage":{"outputs":["hs_hts_recommendation","duty_estimate","risk_band","audit_pack","denied_goods_flag"]}}).to_string()
}

fn golden_rule_yaml(code: &str) -> String {
    let cases = (0..10)
        .map(|index| {
            format!(
                "  - product:\n      description: woven cotton shirt yaml case {index}\n      materials:\n        - cotton\n    expected_code: \"{code}\""
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"rules:
  - id: shirt
    code: "{code}"
    contains: shirt
    confidence: 0.91
    risk_band: low
golden_cases:
{cases}
coverage:
  outputs:
    - hs_hts_recommendation
    - duty_estimate
    - risk_band
    - audit_pack
    - denied_goods_flag
"#
    )
}

#[tokio::test]
async fn product_import_persists_search_document_and_tenant_search_finds_it() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let api_key = register_tenant(app.clone(), "Search Tenant", "search@example.test").await;
    let import = json!({"rows":[{"sku":"SEA-1","name":"Organic cotton shirt","description":"Blue woven shirt for retail","country_of_origin":"NG","jurisdiction":"US","product_type":"apparel","materials":["organic cotton"],"intended_use":"retail sale"}]});
    let (status, body) = request_json(
        app.clone(),
        post_json("/api/products/import", &api_key, import),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body) = request_json(
        app.clone(),
        get("/api/products?query=organic%20cotton", &api_key),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"][0]["sku"], "SEA-1");
    assert!(body["items"][0]["search_document"]
        .as_str()
        .unwrap()
        .contains("organic cotton"));

    let tenant_id: uuid::Uuid =
        sqlx::query_scalar("SELECT tenant_id FROM api_keys WHERE key_hash = $1")
            .bind(hash_api_key(&api_key, "test-pepper"))
            .fetch_one(&pool)
            .await
            .unwrap();
    let index = ProductSearchIndex::in_memory().unwrap();
    index
        .index(ProductSearchDocument {
            tenant_id,
            product_id: uuid::Uuid::new_v4(),
            sku: "SEA-2".into(),
            name: "Cotton socks".into(),
            description: "Organic socks".into(),
            materials: vec!["cotton".into()],
            intended_use: Some("retail".into()),
        })
        .unwrap();
    assert_eq!(index.search(tenant_id, "organic", 10).unwrap().len(), 1);
}

#[tokio::test]
async fn rule_pack_upload_validate_activate_is_admin_only_and_immutable() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let admin_key = register_tenant(app.clone(), "Rules Tenant", "rules@example.test").await;
    let auditor_key = register_tenant(app.clone(), "Auditor Tenant", "auditor@example.test").await;
    sqlx::query("UPDATE users SET scope = 'auditor' WHERE email = 'auditor@example.test'")
        .execute(&pool)
        .await
        .unwrap();

    let pack = json!({"name":"mvp-hs","version":"2026.1","jurisdiction":"US","source":golden_rule_source("6205.20")});
    let (status, body) = request_json(
        app.clone(),
        post_json("/api/rule-packs/upload", &auditor_key, pack.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    let (status, body) = request_json(
        app.clone(),
        post_json("/api/rule-packs/upload", &admin_key, pack),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let id = body["id"].as_str().unwrap();
    assert_eq!(body["validation_report"]["valid"], true);

    let (status, body) = request_json(
        app.clone(),
        post_json(
            &format!("/api/rule-packs/{id}/validate"),
            &admin_key,
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["valid"], true);

    let (status, body) = request_json(
        app.clone(),
        post_json(
            &format!("/api/rule-packs/{id}/activate"),
            &admin_key,
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "active");

    let update_result = sqlx::query("UPDATE rule_packs SET payload = '{}'::jsonb WHERE id = $1")
        .bind(uuid::Uuid::parse_str(id).unwrap())
        .execute(&pool)
        .await;
    assert!(
        update_result.is_err(),
        "active rule packs must be immutable"
    );
}

#[tokio::test]
async fn product_search_uses_persisted_document_after_index_restart() {
    let (pool, _guard) = test_pool().await;
    let first_app = app(test_state(pool.clone()));
    let api_key = register_tenant(
        first_app.clone(),
        "Restart Search Tenant",
        "restart-search@example.test",
    )
    .await;
    let import = json!({"rows":[{"sku":"RESTART-1","name":"Ceramic kitchen bowl","description":"Glazed ceramic serving bowl","country_of_origin":"GB","jurisdiction":"UK","product_type":"tableware","materials":["ceramic"],"intended_use":"kitchen serving"}]});
    let (status, body) = request_json(
        first_app.clone(),
        post_json("/api/products/import", &api_key, import),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let restarted_app = app(test_state(pool.clone()));
    let (status, body) = request_json(
        restarted_app,
        get("/api/products?query=ceramic%20serving", &api_key),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"][0]["sku"], "RESTART-1");
}

#[tokio::test]
async fn rule_pack_yaml_contract_and_version_uniqueness_are_enforced() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let admin_key =
        register_tenant(app.clone(), "Yaml Rules Tenant", "yaml-rules@example.test").await;

    let pack = json!({"name":"yaml-pack-a","version":"2026.1","jurisdiction":"US","source":golden_rule_yaml("YAML-6205")});
    let (status, body) =
        request_json(app.clone(), post_json("/api/rule-packs", &admin_key, pack)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["validation_report"]["matrix_coverage"]["valid"], true);

    let duplicate = json!({"name":"yaml-pack-b","version":"2026.1","jurisdiction":"US","source":golden_rule_yaml("YAML-6205")});
    let (status, body) = request_json(
        app.clone(),
        post_json("/api/rule-packs", &admin_key, duplicate),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "rule_pack_version_conflict");
}

#[tokio::test]
async fn rule_pack_activation_requires_golden_cases_and_retires_same_jurisdiction() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let admin_key = register_tenant(app.clone(), "Gate Tenant", "gate@example.test").await;

    let weak_pack = json!({"name":"weak-us","version":"2026.1","jurisdiction":"US","source":"{\"rules\":[{\"id\":\"shirt\",\"code\":\"6205.20\",\"contains\":\"shirt\",\"confidence\":0.91,\"risk_band\":\"low\"}]}"});
    let (status, body) = request_json(
        app.clone(),
        post_json("/api/rule-packs", &admin_key, weak_pack),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["validation_report"]["golden_case_count"], 0);
    let weak_id = body["id"].as_str().unwrap();
    let (status, body) = request_json(
        app.clone(),
        post_json(
            &format!("/api/rule-packs/{weak_id}/activate"),
            &admin_key,
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "rule_pack_activation_blocked");

    let first_pack = json!({"name":"us-first","version":"2026.2","jurisdiction":"US","source":golden_rule_source("6205.20")});
    let (_, first_body) = request_json(
        app.clone(),
        post_json("/api/rule-packs", &admin_key, first_pack),
    )
    .await;
    let first_id = first_body["id"].as_str().unwrap();
    let (status, body) = request_json(
        app.clone(),
        post_json(
            &format!("/api/rule-packs/{first_id}/activate"),
            &admin_key,
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let second_pack = json!({"name":"us-second","version":"2026.3","jurisdiction":"US","source":golden_rule_source("6205.21")});
    let (_, second_body) = request_json(
        app.clone(),
        post_json("/api/rule-packs", &admin_key, second_pack),
    )
    .await;
    let second_id = second_body["id"].as_str().unwrap();
    let (status, body) = request_json(
        app.clone(),
        post_json(
            &format!("/api/rule-packs/{second_id}/activate"),
            &admin_key,
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let statuses: Vec<(String, String)> = sqlx::query_as(
        "SELECT name, status::text FROM rule_packs WHERE jurisdiction='US' ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(statuses.contains(&("us-first".to_string(), "retired".to_string())));
    assert!(statuses.contains(&("us-second".to_string(), "active".to_string())));
    let active_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM rule_packs WHERE jurisdiction='US' AND status='active'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(active_count, 1, "one active rule pack per jurisdiction");
}

#[tokio::test]
async fn classifier_uses_active_rule_pack_for_product_jurisdiction() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let api_key = register_tenant(
        app.clone(),
        "Jurisdiction Tenant",
        "jurisdiction@example.test",
    )
    .await;

    for (name, jurisdiction, code) in [("eu-rules", "EU", "EU-6205"), ("us-rules", "US", "US-6205")]
    {
        let pack = json!({"name":name,"version":"2026.1","jurisdiction":jurisdiction,"source":golden_rule_source(code)});
        let (_, body) =
            request_json(app.clone(), post_json("/api/rule-packs", &api_key, pack)).await;
        let id = body["id"].as_str().unwrap();
        let (status, body) = request_json(
            app.clone(),
            post_json(
                &format!("/api/rule-packs/{id}/activate"),
                &api_key,
                json!({}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    let import = json!({"rows":[{"sku":"EU-JOB-1","name":"Cotton shirt","description":"woven cotton shirt","country_of_origin":"NG","jurisdiction":"EU","product_type":"apparel","materials":["cotton"],"intended_use":"retail sale"}]});
    let _ = request_json(
        app.clone(),
        post_json("/api/products/import", &api_key, import),
    )
    .await;
    let tenant_id: uuid::Uuid =
        sqlx::query_scalar("SELECT tenant_id FROM api_keys WHERE key_hash = $1")
            .bind(hash_api_key(&api_key, "test-pepper"))
            .fetch_one(&pool)
            .await
            .unwrap();
    let product_id: uuid::Uuid =
        sqlx::query_scalar("SELECT id FROM products WHERE tenant_id=$1 AND sku='EU-JOB-1'")
            .bind(tenant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let rule_pack_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT id FROM rule_packs WHERE tenant_id=$1 AND name='eu-rules' AND status='active'",
    )
    .bind(tenant_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let input_snapshot = json!({
        "id": product_id,
        "sku": "EU-JOB-1",
        "name": "Cotton shirt",
        "description": "woven cotton shirt",
        "country_of_origin": "NG",
        "jurisdiction": "EU",
        "product_type": "apparel",
        "materials": ["cotton"],
        "intended_use": "retail sale",
        "source_row": {}
    });
    let run_id: uuid::Uuid = sqlx::query_scalar("INSERT INTO classification_runs (tenant_id, product_id, rule_pack_id, jurisdiction, product_snapshot, input_snapshot, rule_pack_version, status) VALUES ($1,$2,$3,'EU',$4,$4,'2026.1','queued') RETURNING id")
        .bind(tenant_id)
        .bind(product_id)
        .bind(rule_pack_id)
        .bind(input_snapshot.clone())
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO classification_jobs (tenant_id, product_id, classification_run_id, payload) VALUES ($1,$2,$3,$4)")
        .bind(tenant_id)
        .bind(product_id)
        .bind(run_id)
        .bind(json!({"classification_run_id":run_id,"product_id":product_id,"rule_pack_id":rule_pack_id,"jurisdiction":"EU","input_snapshot":input_snapshot}))
        .execute(&pool)
        .await
        .unwrap();
    let _ = lease_classification_jobs(
        &pool,
        "jurisdiction-worker",
        10,
        std::time::Duration::from_secs(30),
    )
    .await
    .unwrap();
    let report = classify_queued_products(&pool, "jurisdiction-worker", 10)
        .await
        .unwrap();
    assert_eq!(report.completed, 1);
    let selected_code: String = sqlx::query_scalar(
        "SELECT selected_code FROM classification_runs WHERE tenant_id=$1 AND product_id=$2",
    )
    .bind(tenant_id)
    .bind(product_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(selected_code, "EU-6205");
}

#[tokio::test]
async fn wasm_runtime_maps_deterministic_matches_and_safety_failures() {
    let runtime =
        RuleRuntime::deterministic_test_runtime(10_000, std::time::Duration::from_millis(50));
    let pack = json!({"rules":[{"id":"shirt","code":"6205.20","contains":"shirt","confidence":0.91,"risk_band":"low"}]});
    let product = json!({"description":"woven cotton shirt","materials":["cotton"]});
    let result = runtime.evaluate_json(&pack, &product).unwrap();
    assert_eq!(result.selected_code.as_deref(), Some("6205.20"));
    assert_eq!(result.rejected_candidates.len(), 0);

    let exhausted = runtime
        .evaluate_json(&json!({"simulate":"fuel_exhausted","rules":[]}), &product)
        .unwrap_err();
    assert!(matches!(exhausted, RuleRuntimeError::FuelExhausted));
    let timed_out = runtime
        .evaluate_json(&json!({"simulate":"timeout","rules":[]}), &product)
        .unwrap_err();
    assert!(matches!(timed_out, RuleRuntimeError::Timeout));
}

#[tokio::test]
async fn classification_worker_uses_queued_run_payload_snapshot_and_run_idempotency() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let api_key = register_tenant(
        app.clone(),
        "Snapshot Jobs Tenant",
        "snapshot-jobs@example.test",
    )
    .await;
    for (name, code, contains) in [
        ("cotton-pack", "COTTON-6205", "cotton"),
        ("poly-pack", "POLY-0000", "polyester"),
    ] {
        let source = json!({
            "rules":[{"id":name,"code":code,"contains":contains,"confidence":0.91,"risk_band":"low"}],
            "golden_cases":(0..10).map(|index| json!({"product":{"description":format!("{contains} fixture {index}"),"materials":[contains]},"expected_code":code})).collect::<Vec<_>>(),
            "coverage":{"outputs":["hs_hts_recommendation","duty_estimate","risk_band","audit_pack","denied_goods_flag"]}
        }).to_string();
        let version = if name == "cotton-pack" {
            "2026.1"
        } else {
            "2026.2"
        };
        let pack = json!({"name":name,"version":version,"jurisdiction":"US","source":source});
        let (_, body) =
            request_json(app.clone(), post_json("/api/rule-packs", &api_key, pack)).await;
        let id = body["id"].as_str().unwrap();
        let (status, body) = request_json(
            app.clone(),
            post_json(
                &format!("/api/rule-packs/{id}/activate"),
                &api_key,
                json!({}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    let import = json!({"rows":[{"sku":"SNAP-1","name":"Queued cotton shirt","description":"woven cotton shirt before edit","country_of_origin":"NG","jurisdiction":"US","product_type":"apparel","materials":["cotton"],"intended_use":"retail sale"}]});
    let _ = request_json(
        app.clone(),
        post_json("/api/products/import", &api_key, import),
    )
    .await;
    let tenant_id: uuid::Uuid =
        sqlx::query_scalar("SELECT tenant_id FROM api_keys WHERE key_hash = $1")
            .bind(hash_api_key(&api_key, "test-pepper"))
            .fetch_one(&pool)
            .await
            .unwrap();
    let product_id: uuid::Uuid =
        sqlx::query_scalar("SELECT id FROM products WHERE tenant_id=$1 AND sku='SNAP-1'")
            .bind(tenant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let queued_pack_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT id FROM rule_packs WHERE tenant_id=$1 AND name='cotton-pack' AND status='retired'",
    )
    .bind(tenant_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let queued_snapshot = json!({
        "id": product_id,
        "sku": "SNAP-1",
        "name": "Queued cotton shirt",
        "description": "woven cotton shirt before edit",
        "country_of_origin": "NG",
        "jurisdiction": "US",
        "product_type": "apparel",
        "materials": ["cotton"],
        "intended_use": "retail sale",
        "source_row": {"queued": true}
    });
    let run_id: uuid::Uuid = sqlx::query_scalar("INSERT INTO classification_runs (tenant_id, product_id, rule_pack_id, jurisdiction, product_snapshot, input_snapshot, rule_pack_version, status) VALUES ($1,$2,$3,'US',$4,$4,'2026.1','queued') RETURNING id")
        .bind(tenant_id)
        .bind(product_id)
        .bind(queued_pack_id)
        .bind(queued_snapshot.clone())
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE products SET description='polyester pants after queue', materials='[\"polyester\"]'::jsonb WHERE id=$1")
        .bind(product_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO classification_jobs (tenant_id, product_id, classification_run_id, payload) VALUES ($1,$2,$3,$4)")
        .bind(tenant_id)
        .bind(product_id)
        .bind(run_id)
        .bind(json!({"classification_run_id":run_id,"product_id":product_id,"rule_pack_id":queued_pack_id,"jurisdiction":"US","input_snapshot":queued_snapshot}))
        .execute(&pool)
        .await
        .unwrap();

    let leased = lease_classification_jobs(
        &pool,
        "snapshot-worker",
        10,
        std::time::Duration::from_secs(30),
    )
    .await
    .unwrap();
    assert_eq!(leased.len(), 1);
    assert_eq!(leased[0].classification_run_id, Some(run_id));
    assert_eq!(
        leased[0].payload["classification_run_id"],
        run_id.to_string()
    );

    let first = classify_queued_products(&pool, "snapshot-worker", 10)
        .await
        .unwrap();
    let second = classify_queued_products(&pool, "snapshot-worker", 10)
        .await
        .unwrap();
    assert_eq!(first.completed, 1);
    assert_eq!(second.completed, 0);
    let run = sqlx::query("SELECT selected_code, input_snapshot, product_snapshot FROM classification_runs WHERE id=$1")
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(run.get::<String, _>("selected_code"), "COTTON-6205");
    assert_eq!(run.get::<Value, _>("input_snapshot"), queued_snapshot);
    assert_eq!(run.get::<Value, _>("product_snapshot"), queued_snapshot);
    let run_count: i64 = sqlx::query_scalar("SELECT count(*) FROM classification_runs WHERE id=$1")
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        run_count, 1,
        "duplicate delivery must not create a second run"
    );
}

#[tokio::test]
async fn classify_queued_products_leases_jobs_once_and_is_idempotent() {
    let (pool, _guard) = test_pool().await;
    let app = app(test_state(pool.clone()));
    let api_key = register_tenant(app.clone(), "Jobs Tenant", "jobs@example.test").await;
    let pack = json!({"name":"mvp-hs","version":"2026.1","jurisdiction":"US","source":golden_rule_source("6205.20")});
    let (_, pack_body) = request_json(
        app.clone(),
        post_json("/api/rule-packs/upload", &api_key, pack),
    )
    .await;
    let pack_id = pack_body["id"].as_str().unwrap();
    let _ = request_json(
        app.clone(),
        post_json(
            &format!("/api/rule-packs/{pack_id}/activate"),
            &api_key,
            json!({}),
        ),
    )
    .await;
    let import = json!({"rows":[{"sku":"JOB-1","name":"Cotton shirt","description":"woven cotton shirt","country_of_origin":"NG","jurisdiction":"US","product_type":"apparel","materials":["cotton"],"intended_use":"retail sale"}]});
    let _ = request_json(
        app.clone(),
        post_json("/api/products/import", &api_key, import),
    )
    .await;
    let tenant_id: uuid::Uuid =
        sqlx::query_scalar("SELECT tenant_id FROM api_keys WHERE key_hash = $1")
            .bind(hash_api_key(&api_key, "test-pepper"))
            .fetch_one(&pool)
            .await
            .unwrap();
    let product_id: uuid::Uuid =
        sqlx::query_scalar("SELECT id FROM products WHERE tenant_id=$1 AND sku='JOB-1'")
            .bind(tenant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let rule_pack_id: uuid::Uuid = sqlx::query_scalar(
        "SELECT id FROM rule_packs WHERE tenant_id=$1 AND name='mvp-hs' AND status='active'",
    )
    .bind(tenant_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let input_snapshot = json!({
        "id": product_id,
        "sku": "JOB-1",
        "name": "Cotton shirt",
        "description": "woven cotton shirt",
        "country_of_origin": "NG",
        "jurisdiction": "US",
        "product_type": "apparel",
        "materials": ["cotton"],
        "intended_use": "retail sale",
        "source_row": {}
    });
    let run_id: uuid::Uuid = sqlx::query_scalar("INSERT INTO classification_runs (tenant_id, product_id, rule_pack_id, jurisdiction, product_snapshot, input_snapshot, rule_pack_version, status) VALUES ($1,$2,$3,'US',$4,$4,'2026.1','queued') RETURNING id")
        .bind(tenant_id)
        .bind(product_id)
        .bind(rule_pack_id)
        .bind(input_snapshot.clone())
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO classification_jobs (tenant_id, product_id, classification_run_id, payload) VALUES ($1,$2,$3,$4)")
        .bind(tenant_id)
        .bind(product_id)
        .bind(run_id)
        .bind(json!({"classification_run_id":run_id,"product_id":product_id,"rule_pack_id":rule_pack_id,"jurisdiction":"US","input_snapshot":input_snapshot}))
        .execute(&pool)
        .await
        .unwrap();

    let first_lease =
        lease_classification_jobs(&pool, "worker-a", 10, std::time::Duration::from_secs(30))
            .await
            .unwrap();
    assert_eq!(first_lease.len(), 1);
    let second_lease =
        lease_classification_jobs(&pool, "worker-b", 10, std::time::Duration::from_secs(30))
            .await
            .unwrap();
    assert_eq!(
        second_lease.len(),
        0,
        "leased jobs must not be leased twice before expiry"
    );

    let first = classify_queued_products(&pool, "worker-a", 10)
        .await
        .unwrap();
    let second = classify_queued_products(&pool, "worker-a", 10)
        .await
        .unwrap();
    assert_eq!(first.completed, 1);
    assert_eq!(second.completed, 0);
    let run_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM classification_runs WHERE tenant_id=$1 AND product_id=$2",
    )
    .bind(tenant_id)
    .bind(product_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        run_count, 1,
        "worker must be idempotent for the same queued product"
    );
}

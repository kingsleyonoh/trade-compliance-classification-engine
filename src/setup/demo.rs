use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::{db_error, SetupError};

pub(super) async fn seed(
    pool: &PgPool,
    api_key_pepper: String,
) -> Result<Option<String>, SetupError> {
    let seed = DemoSeed::new(api_key_pepper)?;
    let mut tx = pool.begin().await.map_err(db_error)?;
    upsert_demo_tenant(&mut tx, &seed).await?;
    upsert_demo_admin(&mut tx, &seed).await?;
    let generated_api_key = ensure_demo_api_key(&mut tx, &seed).await?;
    upsert_demo_rule_pack(&mut tx, &seed).await?;
    upsert_demo_products(&mut tx, &seed).await?;
    tx.commit().await.map_err(db_error)?;
    Ok(generated_api_key)
}

struct DemoSeed {
    tenant_id: Uuid,
    user_id: Uuid,
    api_key_pepper: String,
}

impl DemoSeed {
    fn new(api_key_pepper: String) -> Result<Self, SetupError> {
        Ok(Self {
            tenant_id: parse_demo_uuid("11111111-1111-4111-8111-111111111111")?,
            user_id: parse_demo_uuid("22222222-2222-4222-8222-222222222222")?,
            api_key_pepper,
        })
    }
}

async fn upsert_demo_tenant(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    seed: &DemoSeed,
) -> Result<(), SetupError> {
    sqlx::query("INSERT INTO tenants (id, slug, legal_name, full_legal_name, display_name, address, registration, contact, wordmark, regulator_ids) VALUES ($1,'demo-importer','Demo Importer Ltd','Demo Importer Limited','Demo Importer',$2,$3,$4,'Demo Importer',$5) ON CONFLICT (slug) DO UPDATE SET legal_name = EXCLUDED.legal_name, full_legal_name = EXCLUDED.full_legal_name, display_name = EXCLUDED.display_name, address = EXCLUDED.address, registration = EXCLUDED.registration, contact = EXCLUDED.contact, wordmark = EXCLUDED.wordmark, regulator_ids = EXCLUDED.regulator_ids")
        .bind(seed.tenant_id)
        .bind(json!({"line1":"1 Compliance Way","country":"GB"}))
        .bind(json!({"number":"DEMO-REG-001"}))
        .bind(json!({"email":"admin@demo-importer.example"}))
        .bind(json!({"eori":"GBDEMO001"}))
        .execute(&mut **tx)
        .await
        .map(|_| ())
        .map_err(db_error)
}

async fn upsert_demo_admin(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    seed: &DemoSeed,
) -> Result<(), SetupError> {
    sqlx::query("INSERT INTO users (id, tenant_id, email, scope) VALUES ($1,$2,'admin@demo-importer.example','admin') ON CONFLICT (tenant_id, email) DO UPDATE SET scope = EXCLUDED.scope")
        .bind(seed.user_id)
        .bind(seed.tenant_id)
        .execute(&mut **tx)
        .await
        .map(|_| ())
        .map_err(db_error)
}

async fn ensure_demo_api_key(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    seed: &DemoSeed,
) -> Result<Option<String>, SetupError> {
    if demo_api_key_exists(tx, seed).await? {
        return Ok(None);
    }
    let api_key = format!(
        "tcce_demo_{}_{}",
        seed.tenant_id.simple(),
        Uuid::new_v4().simple()
    );
    let key_hash = crate::auth::hash_api_key(&api_key, &seed.api_key_pepper);
    let key_prefix = api_key.chars().take(12).collect::<String>();
    insert_demo_api_key(tx, seed, key_hash, key_prefix).await?;
    Ok(Some(api_key))
}

async fn demo_api_key_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    seed: &DemoSeed,
) -> Result<bool, SetupError> {
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM api_keys WHERE tenant_id = $1 AND user_id = $2")
            .bind(seed.tenant_id)
            .bind(seed.user_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(db_error)?;
    Ok(count > 0)
}

async fn insert_demo_api_key(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    seed: &DemoSeed,
    key_hash: String,
    key_prefix: String,
) -> Result<(), SetupError> {
    sqlx::query(
        "INSERT INTO api_keys (tenant_id, user_id, key_hash, key_prefix) VALUES ($1,$2,$3,$4)",
    )
    .bind(seed.tenant_id)
    .bind(seed.user_id)
    .bind(key_hash)
    .bind(key_prefix)
    .execute(&mut **tx)
    .await
    .map(|_| ())
    .map_err(db_error)
}

async fn upsert_demo_rule_pack(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    seed: &DemoSeed,
) -> Result<(), SetupError> {
    let demo_rule_payload = demo_rule_payload();
    sqlx::query("INSERT INTO rule_packs (tenant_id, name, version, jurisdiction, source_yaml, source_hash, compiled_wasm_sha256, golden_case_count, status, payload, validation_report, activated_at) VALUES ($1,'demo-hs-rules','2026.1','US',$2,$3,$3,10,'active',$4,$5,now()) ON CONFLICT (tenant_id, name, version) DO NOTHING")
        .bind(seed.tenant_id)
        .bind(demo_rule_payload.to_string())
        .bind(crate::auth::hash_api_key(&demo_rule_payload.to_string(), &seed.api_key_pepper))
        .bind(demo_rule_payload)
        .bind(json!({"valid":true,"errors":[],"rule_count":1,"golden_case_count":10,"wasm_safety":{"valid":true},"matrix_coverage":{"valid":true}}))
        .execute(&mut **tx)
        .await
        .map(|_| ())
        .map_err(db_error)
}

async fn upsert_demo_products(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    seed: &DemoSeed,
) -> Result<(), SetupError> {
    for product in demo_products() {
        upsert_demo_product(tx, seed.tenant_id, product).await?;
    }
    Ok(())
}

async fn upsert_demo_product(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    tenant_id: Uuid,
    product: DemoProduct,
) -> Result<(), SetupError> {
    sqlx::query("INSERT INTO products (tenant_id, sku, name, description, country_of_origin, jurisdiction, product_type, materials, intended_use, readiness_status, source_row) VALUES ($1,$2,$3,$4,$5,$6,'demo',$7,'classification demo','ready',$8) ON CONFLICT (tenant_id, sku) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, country_of_origin = EXCLUDED.country_of_origin, jurisdiction = EXCLUDED.jurisdiction, product_type = EXCLUDED.product_type, materials = EXCLUDED.materials, intended_use = EXCLUDED.intended_use, readiness_status = EXCLUDED.readiness_status, source_row = EXCLUDED.source_row")
        .bind(tenant_id)
        .bind(product.sku)
        .bind(product.name)
        .bind(product.description)
        .bind(product.origin)
        .bind(product.jurisdiction)
        .bind(product.materials)
        .bind(json!({"seed":"setup"}))
        .execute(&mut **tx)
        .await
        .map(|_| ())
        .map_err(db_error)
}

struct DemoProduct {
    sku: &'static str,
    name: &'static str,
    description: &'static str,
    origin: &'static str,
    jurisdiction: &'static str,
    materials: Value,
}

fn demo_products() -> [DemoProduct; 2] {
    [
        DemoProduct {
            sku: "DEMO-001",
            name: "Cotton shirt",
            description: "Men's woven cotton shirt",
            origin: "NG",
            jurisdiction: "US",
            materials: json!(["cotton"]),
        },
        DemoProduct {
            sku: "DEMO-002",
            name: "Industrial pump",
            description: "Centrifugal water pump for factory use",
            origin: "GB",
            jurisdiction: "EU",
            materials: json!(["steel"]),
        },
    ]
}

fn demo_rule_payload() -> Value {
    let demo_golden_cases = (0..10)
        .map(|index| json!({"product":{"description":format!("woven cotton shirt demo case {index}"),"materials":["cotton"]},"expected_code":"6205"}))
        .collect::<Vec<_>>();
    json!({"rules":[{"id":"demo-shirt","code":"6205","contains":"shirt","confidence":0.91,"risk_band":"low"}],"golden_cases":demo_golden_cases})
}

fn parse_demo_uuid(value: &str) -> Result<Uuid, SetupError> {
    Uuid::parse_str(value).map_err(|error| SetupError::Database(error.to_string()))
}

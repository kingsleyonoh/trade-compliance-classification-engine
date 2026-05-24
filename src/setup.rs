use std::{env, future::Future, pin::Pin};

use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::AppConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupMode {
    Apply,
    DryRun,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupStatus {
    PendingDatabase,
    Seeded { generated_api_key: Option<String> },
    DryRunReady,
}

pub trait SetupTarget {
    fn run_setup_target<'a>(
        &'a self,
        mode: SetupMode,
    ) -> Pin<Box<dyn Future<Output = Result<SetupStatus, SetupError>> + Send + 'a>>;
}

pub async fn run_setup<T: SetupTarget + Sync>(
    target: &T,
    mode: SetupMode,
) -> Result<SetupStatus, SetupError> {
    target.run_setup_target(mode).await
}

impl SetupTarget for AppConfig {
    fn run_setup_target<'a>(
        &'a self,
        _mode: SetupMode,
    ) -> Pin<Box<dyn Future<Output = Result<SetupStatus, SetupError>> + Send + 'a>> {
        Box::pin(async move {
            if self.database_url.trim().is_empty() {
                return Err(SetupError::MissingDatabaseUrl);
            }
            Ok(SetupStatus::PendingDatabase)
        })
    }
}

impl SetupTarget for PgPool {
    fn run_setup_target<'a>(
        &'a self,
        mode: SetupMode,
    ) -> Pin<Box<dyn Future<Output = Result<SetupStatus, SetupError>> + Send + 'a>> {
        Box::pin(async move { seed_database(self, mode).await })
    }
}

async fn seed_database(pool: &PgPool, mode: SetupMode) -> Result<SetupStatus, SetupError> {
    sqlx::migrate!()
        .run(pool)
        .await
        .map_err(|error| SetupError::Database(error.to_string()))?;
    if matches!(mode, SetupMode::DryRun) {
        return Ok(SetupStatus::DryRunReady);
    }

    let tenant_id =
        Uuid::parse_str("11111111-1111-4111-8111-111111111111").expect("static demo uuid");
    let user_id =
        Uuid::parse_str("22222222-2222-4222-8222-222222222222").expect("static demo uuid");
    let api_key_pepper = env::var("API_KEY_PEPPER").map_err(|_| {
        SetupError::MissingSecret("API_KEY_PEPPER is required to hash setup API keys".to_string())
    })?;

    let mut tx = pool
        .begin()
        .await
        .map_err(|error| SetupError::Database(error.to_string()))?;
    sqlx::query("INSERT INTO tenants (id, slug, legal_name, full_legal_name, display_name, address, registration, contact, wordmark, regulator_ids) VALUES ($1,'demo-importer','Demo Importer Ltd','Demo Importer Limited','Demo Importer',$2,$3,$4,'Demo Importer',$5) ON CONFLICT (slug) DO UPDATE SET legal_name = EXCLUDED.legal_name, full_legal_name = EXCLUDED.full_legal_name, display_name = EXCLUDED.display_name, address = EXCLUDED.address, registration = EXCLUDED.registration, contact = EXCLUDED.contact, wordmark = EXCLUDED.wordmark, regulator_ids = EXCLUDED.regulator_ids")
        .bind(tenant_id)
        .bind(json!({"line1":"1 Compliance Way","country":"GB"}))
        .bind(json!({"number":"DEMO-REG-001"}))
        .bind(json!({"email":"admin@demo-importer.example"}))
        .bind(json!({"eori":"GBDEMO001"}))
        .execute(&mut *tx)
        .await
        .map_err(|error| SetupError::Database(error.to_string()))?;
    sqlx::query("INSERT INTO users (id, tenant_id, email, scope) VALUES ($1,$2,'admin@demo-importer.example','admin') ON CONFLICT (tenant_id, email) DO UPDATE SET scope = EXCLUDED.scope")
        .bind(user_id)
        .bind(tenant_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| SetupError::Database(error.to_string()))?;
    let existing_key_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM api_keys WHERE tenant_id = $1 AND user_id = $2")
            .bind(tenant_id)
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|error| SetupError::Database(error.to_string()))?;
    let generated_api_key = if existing_key_count == 0 {
        let api_key = format!(
            "tcce_demo_{}_{}",
            tenant_id.simple(),
            Uuid::new_v4().simple()
        );
        let key_hash = crate::auth::hash_api_key(&api_key, &api_key_pepper);
        let key_prefix = api_key.chars().take(12).collect::<String>();
        sqlx::query(
            "INSERT INTO api_keys (tenant_id, user_id, key_hash, key_prefix) VALUES ($1,$2,$3,$4)",
        )
        .bind(tenant_id)
        .bind(user_id)
        .bind(key_hash)
        .bind(key_prefix)
        .execute(&mut *tx)
        .await
        .map_err(|error| SetupError::Database(error.to_string()))?;
        Some(api_key)
    } else {
        None
    };
    let demo_golden_cases = (0..10)
        .map(|index| json!({"product":{"description":format!("woven cotton shirt demo case {index}"),"materials":["cotton"]},"expected_code":"6205"}))
        .collect::<Vec<_>>();
    let demo_rule_payload = json!({"rules":[{"id":"demo-shirt","code":"6205","contains":"shirt","confidence":0.91,"risk_band":"low"}],"golden_cases":demo_golden_cases});
    sqlx::query("INSERT INTO rule_packs (tenant_id, name, version, jurisdiction, source_yaml, source_hash, compiled_wasm_sha256, golden_case_count, status, payload, validation_report, activated_at) VALUES ($1,'demo-hs-rules','2026.1','US',$2,$3,$3,10,'active',$4,$5,now()) ON CONFLICT (tenant_id, name, version) DO NOTHING")
        .bind(tenant_id)
        .bind(demo_rule_payload.to_string())
        .bind(crate::auth::hash_api_key(&demo_rule_payload.to_string(), &api_key_pepper))
        .bind(demo_rule_payload)
        .bind(json!({"valid":true,"errors":[],"rule_count":1,"golden_case_count":10,"wasm_safety":{"valid":true},"matrix_coverage":{"valid":true}}))
        .execute(&mut *tx)
        .await
        .map_err(|error| SetupError::Database(error.to_string()))?;

    for (sku, name, description, origin, jurisdiction, materials) in [
        (
            "DEMO-001",
            "Cotton shirt",
            "Men's woven cotton shirt",
            "NG",
            "US",
            json!(["cotton"]),
        ),
        (
            "DEMO-002",
            "Industrial pump",
            "Centrifugal water pump for factory use",
            "GB",
            "EU",
            json!(["steel"]),
        ),
    ] {
        sqlx::query("INSERT INTO products (tenant_id, sku, name, description, country_of_origin, jurisdiction, product_type, materials, intended_use, readiness_status, source_row) VALUES ($1,$2,$3,$4,$5,$6,'demo',$7,'classification demo','ready',$8) ON CONFLICT (tenant_id, sku) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, country_of_origin = EXCLUDED.country_of_origin, jurisdiction = EXCLUDED.jurisdiction, product_type = EXCLUDED.product_type, materials = EXCLUDED.materials, intended_use = EXCLUDED.intended_use, readiness_status = EXCLUDED.readiness_status, source_row = EXCLUDED.source_row")
            .bind(tenant_id)
            .bind(sku)
            .bind(name)
            .bind(description)
            .bind(origin)
            .bind(jurisdiction)
            .bind(materials)
            .bind(json!({"seed":"setup"}))
            .execute(&mut *tx)
            .await
            .map_err(|error| SetupError::Database(error.to_string()))?;
    }
    tx.commit()
        .await
        .map_err(|error| SetupError::Database(error.to_string()))?;
    Ok(SetupStatus::Seeded { generated_api_key })
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SetupError {
    #[error("DATABASE_URL is required before setup can run")]
    MissingDatabaseUrl,
    #[error("{0}")]
    MissingSecret(String),
    #[error("database setup failed: {0}")]
    Database(String),
}

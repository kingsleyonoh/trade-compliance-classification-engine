use axum::{
    routing::{get, post},
    Router,
};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::{errors::ApiError, search::index::ProductSearchIndex, telemetry::MetricsRegistry};

pub mod classifications;
pub mod health;
pub mod products;
pub mod rule_packs;
pub mod tenants;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub self_registration_enabled: bool,
    pub metrics: MetricsRegistry,
    pub api_key_pepper: String,
    pub registration_limiter: RegistrationLimiter,
    pub product_search_index: ProductSearchIndex,
}

impl AppState {
    pub fn new(
        pool: PgPool,
        self_registration_enabled: bool,
        metrics: MetricsRegistry,
        api_key_pepper: impl Into<String>,
    ) -> Self {
        Self {
            pool,
            self_registration_enabled,
            metrics,
            api_key_pepper: api_key_pepper.into(),
            registration_limiter: RegistrationLimiter::default(),
            product_search_index: ProductSearchIndex::default(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RegistrationLimiter {
    attempts: Arc<Mutex<HashMap<String, Vec<Instant>>>>,
    max_attempts: usize,
    window: Duration,
}

impl Default for RegistrationLimiter {
    fn default() -> Self {
        Self {
            attempts: Arc::new(Mutex::new(HashMap::new())),
            max_attempts: 5,
            window: Duration::from_secs(60 * 60),
        }
    }
}

impl RegistrationLimiter {
    pub fn check(&self, key: &str) -> Result<(), ApiError> {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().map_err(|_| {
            ApiError::service_unavailable(
                "rate_limit_unavailable",
                "registration rate limiter failed",
            )
        })?;
        let entries = attempts.entry(key.to_owned()).or_default();
        entries.retain(|instant| now.duration_since(*instant) < self.window);
        if entries.len() >= self.max_attempts {
            return Err(ApiError::too_many_requests(
                "registration_rate_limited",
                "too many registration attempts; retry later",
            ));
        }
        entries.push(now);
        Ok(())
    }
}

pub fn app(state: AppState) -> Router {
    Router::new()
        .route(
            "/",
            get(|| async { "Trade Compliance Classification Engine" }),
        )
        .route("/health", get(health::health))
        .route("/health/db", get(health::health_db))
        .route("/health/ready", get(health::health_ready))
        .route("/metrics", get(health::metrics))
        .route("/tenants/me", get(tenants::me))
        .route("/api/tenants/register", post(tenants::register))
        .route("/api/products", get(products::list_products))
        .route("/api/products/import", post(products::import_products))
        .route("/api/products/:id", get(products::get_product))
        .route(
            "/api/classifications/run",
            post(classifications::run_classifications),
        )
        .route(
            "/api/classifications",
            get(classifications::list_classifications),
        )
        .route(
            "/api/classifications/:id",
            get(classifications::get_classification),
        )
        .route("/api/rule-packs", post(rule_packs::upload_rule_pack))
        .route("/api/rule-packs/upload", post(rule_packs::upload_rule_pack))
        .route(
            "/api/rule-packs/:id/validate",
            post(rule_packs::validate_rule_pack),
        )
        .route(
            "/api/rule-packs/:id/activate",
            post(rule_packs::activate_rule_pack),
        )
        .with_state(state)
}

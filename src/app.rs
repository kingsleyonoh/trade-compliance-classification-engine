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

use crate::ui;
use crate::{errors::ApiError, search::index::ProductSearchIndex, telemetry::MetricsRegistry};

pub mod audit_exports;
pub mod classifications;
pub mod health;
pub mod products;
pub mod reviews;
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
    all_routes().with_state(state)
}

fn all_routes() -> Router<AppState> {
    ui_routes(rule_pack_routes(audit_routes(classification_routes(
        product_routes(base_routes()),
    ))))
}

fn base_routes() -> Router<AppState> {
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
}

fn product_routes(router: Router<AppState>) -> Router<AppState> {
    router
        .route("/api/products", get(products::list_products))
        .route("/api/products/import", post(products::import_products))
        .route("/api/products/:id", get(products::get_product))
}

fn classification_routes(router: Router<AppState>) -> Router<AppState> {
    router
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
        .route(
            "/api/classifications/:id/override",
            post(classifications::create_override),
        )
        .route("/api/reviews", get(reviews::review_queue))
}

fn audit_routes(router: Router<AppState>) -> Router<AppState> {
    router
        .route(
            "/api/audit-exports",
            post(audit_exports::create_audit_export),
        )
        .route(
            "/api/audit-exports/:id/download",
            get(audit_exports::download_audit_export),
        )
}

fn ui_routes(router: Router<AppState>) -> Router<AppState> {
    router
        .route("/ui/login", get(ui::login_page).post(ui::submit_login))
        .route("/ui/dashboard", get(ui::dashboard))
        .route(
            "/ui/products/import",
            get(ui::product_import).post(ui::submit_product_import),
        )
        .route("/ui/products", get(ui::products))
        .route("/ui/classifications", get(ui::classifications))
        .route("/ui/classifications/run", post(ui::submit_run_selected))
        .route(
            "/ui/classifications/detail",
            get(ui::classification_detail_legacy),
        )
        .route("/ui/classifications/:id", get(ui::classification_detail))
        .route(
            "/ui/rule-packs",
            get(ui::rule_packs).post(ui::submit_rule_pack),
        )
        .route("/ui/rule-packs/:id/validate", post(ui::validate_rule_pack))
        .route("/ui/rule-packs/:id/activate", post(ui::activate_rule_pack))
        .route("/ui/reviews", get(ui::reviews))
        .route("/ui/reviews/:id/override", post(ui::submit_review_override))
        .route(
            "/ui/audit-exports",
            get(ui::audit_exports).post(ui::submit_audit_export),
        )
        .route(
            "/ui/audit-exports/:id/download",
            get(ui::download_ui_audit_export),
        )
        .route("/ui/integrations", get(ui::integrations))
}

fn rule_pack_routes(router: Router<AppState>) -> Router<AppState> {
    router
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
}

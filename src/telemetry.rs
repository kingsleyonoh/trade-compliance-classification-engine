use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::http::HeaderMap;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestId(String);

impl RequestId {
    pub fn from_headers(headers: &HeaderMap) -> Self {
        headers
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.trim().is_empty())
            .map(|value| Self(value.to_owned()))
            .unwrap_or_else(|| Self(Uuid::new_v4().to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Default)]
pub struct MetricsRegistry {
    counters: Arc<Mutex<HashMap<MetricKey, u64>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct MetricKey {
    name: &'static str,
    tenant_id: Uuid,
}

impl MetricsRegistry {
    pub fn increment_imports_started(&self, tenant_id: Uuid) {
        self.increment("imports_started_total", tenant_id);
    }

    pub fn imports_started(&self, tenant_id: Uuid) -> u64 {
        self.value("imports_started_total", tenant_id)
    }

    fn increment(&self, name: &'static str, tenant_id: Uuid) {
        let mut counters = self
            .counters
            .lock()
            .expect("metrics lock should not be poisoned");
        let key = MetricKey { name, tenant_id };
        *counters.entry(key).or_insert(0) += 1;
    }

    fn value(&self, name: &'static str, tenant_id: Uuid) -> u64 {
        let counters = self
            .counters
            .lock()
            .expect("metrics lock should not be poisoned");
        counters
            .get(&MetricKey { name, tenant_id })
            .copied()
            .unwrap_or(0)
    }
}

pub fn init_tracing(filter: &str) {
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);
}

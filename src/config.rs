use std::{collections::HashMap, env};

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppConfig {
    pub database_url: String,
    pub app_base_url: String,
    pub bind_addr: String,
    pub self_registration_enabled: bool,
    pub jwt_secret: String,
    pub api_key_pepper: String,
    pub rust_log: String,
    pub sentry_dsn: Option<String>,
    pub rag_platform: OptionalIntegrationConfig,
    pub notification_hub: OptionalIntegrationConfig,
    pub workflow_engine: WorkflowEngineConfig,
    raw: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptionalIntegrationConfig {
    pub enabled: bool,
    pub url: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowEngineConfig {
    pub enabled: bool,
    pub url: Option<String>,
    pub api_key: Option<String>,
    pub high_risk_review_id: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("missing required environment variable {0}")]
    Missing(&'static str),
    #[error("invalid boolean for {name}: {value}")]
    InvalidBool { name: &'static str, value: String },
}

impl AppConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let _ = dotenvy::dotenv();
        let _ = dotenvy::from_filename(".env.local");
        Self::from_map(env::vars().collect())
    }

    pub fn from_env_overrides<I, K, V>(overrides: I) -> Result<Self, ConfigError>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let vars = overrides
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect();
        Self::from_map(vars)
    }

    fn from_map(vars: HashMap<String, String>) -> Result<Self, ConfigError> {
        Ok(Self {
            database_url: required(&vars, "DATABASE_URL")?,
            app_base_url: optional(&vars, "APP_BASE_URL", "http://localhost:8080"),
            bind_addr: optional(&vars, "APP_BIND_ADDR", "127.0.0.1:8080"),
            self_registration_enabled: bool_var(&vars, "SELF_REGISTRATION_ENABLED", true)?,
            jwt_secret: required(&vars, "JWT_SECRET")?,
            api_key_pepper: required(&vars, "API_KEY_PEPPER")?,
            rust_log: optional(&vars, "RUST_LOG", "info"),
            sentry_dsn: optional_non_empty(&vars, "SENTRY_DSN"),
            rag_platform: OptionalIntegrationConfig {
                enabled: bool_var(&vars, "RAG_PLATFORM_ENABLED", false)?,
                url: optional_non_empty(&vars, "RAG_PLATFORM_URL"),
                api_key: optional_non_empty(&vars, "RAG_PLATFORM_API_KEY"),
            },
            notification_hub: OptionalIntegrationConfig {
                enabled: bool_var(&vars, "NOTIFICATION_HUB_ENABLED", false)?,
                url: optional_non_empty(&vars, "NOTIFICATION_HUB_URL"),
                api_key: optional_non_empty(&vars, "NOTIFICATION_HUB_API_KEY"),
            },
            workflow_engine: WorkflowEngineConfig {
                enabled: bool_var(&vars, "WORKFLOW_ENGINE_ENABLED", false)?,
                url: optional_non_empty(&vars, "WORKFLOW_ENGINE_URL"),
                api_key: optional_non_empty(&vars, "WORKFLOW_ENGINE_API_KEY"),
                high_risk_review_id: optional_non_empty(&vars, "WORKFLOW_HIGH_RISK_REVIEW_ID"),
            },
            raw: vars,
        })
    }

    pub fn raw_value(&self, name: &str) -> Option<String> {
        self.raw
            .get(name)
            .filter(|value| !value.trim().is_empty())
            .cloned()
    }
}

fn required(vars: &HashMap<String, String>, name: &'static str) -> Result<String, ConfigError> {
    vars.get(name)
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or(ConfigError::Missing(name))
}

fn optional(vars: &HashMap<String, String>, name: &'static str, default: &str) -> String {
    optional_non_empty(vars, name).unwrap_or_else(|| default.to_owned())
}

fn optional_non_empty(vars: &HashMap<String, String>, name: &'static str) -> Option<String> {
    vars.get(name)
        .filter(|value| !value.trim().is_empty())
        .cloned()
}

fn bool_var(
    vars: &HashMap<String, String>,
    name: &'static str,
    default: bool,
) -> Result<bool, ConfigError> {
    match optional_non_empty(vars, name) {
        Some(value) => value
            .parse::<bool>()
            .map_err(|_| ConfigError::InvalidBool { name, value }),
        None => Ok(default),
    }
}

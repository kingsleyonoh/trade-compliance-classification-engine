use std::time::Duration;

use sqlx::postgres::PgPoolOptions;
use thiserror::Error;

use crate::config::AppConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseConfig {
    pub url: String,
    pub max_connections: u32,
    pub min_connections: u32,
    pub acquire_timeout_seconds: u64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DatabaseConfigError {
    #[error("invalid unsigned integer for {name}: {value}")]
    InvalidInteger { name: &'static str, value: String },
    #[error("DATABASE_MIN_CONNECTIONS must be less than or equal to DATABASE_MAX_CONNECTIONS")]
    MinGreaterThanMax,
}

impl DatabaseConfig {
    pub fn from_app_config(config: &AppConfig) -> Result<Self, DatabaseConfigError> {
        let db_config = Self {
            url: config.database_url.clone(),
            max_connections: parse_u32(config, "DATABASE_MAX_CONNECTIONS", 10)?,
            min_connections: parse_u32(config, "DATABASE_MIN_CONNECTIONS", 1)?,
            acquire_timeout_seconds: parse_u64(config, "DATABASE_ACQUIRE_TIMEOUT_SECONDS", 5)?,
        };
        db_config.validate()?;
        Ok(db_config)
    }

    fn validate(&self) -> Result<(), DatabaseConfigError> {
        if self.min_connections > self.max_connections {
            return Err(DatabaseConfigError::MinGreaterThanMax);
        }
        Ok(())
    }
}

pub fn build_pool_options(config: &DatabaseConfig) -> PgPoolOptions {
    PgPoolOptions::new()
        .max_connections(config.max_connections)
        .min_connections(config.min_connections)
        .acquire_timeout(Duration::from_secs(config.acquire_timeout_seconds))
}

fn parse_u32(
    config: &AppConfig,
    name: &'static str,
    default: u32,
) -> Result<u32, DatabaseConfigError> {
    config
        .raw_value(name)
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| DatabaseConfigError::InvalidInteger { name, value })
        })
        .unwrap_or(Ok(default))
}

fn parse_u64(
    config: &AppConfig,
    name: &'static str,
    default: u64,
) -> Result<u64, DatabaseConfigError> {
    config
        .raw_value(name)
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| DatabaseConfigError::InvalidInteger { name, value })
        })
        .unwrap_or(Ok(default))
}

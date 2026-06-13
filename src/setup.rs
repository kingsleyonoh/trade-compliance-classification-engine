use std::{env, future::Future, pin::Pin};

use sqlx::PgPool;

use crate::config::AppConfig;

mod demo;

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
    run_migrations(pool).await?;
    if matches!(mode, SetupMode::DryRun) {
        return Ok(SetupStatus::DryRunReady);
    }
    let generated_api_key = demo::seed(pool, api_key_pepper()?).await?;
    Ok(SetupStatus::Seeded { generated_api_key })
}

async fn run_migrations(pool: &PgPool) -> Result<(), SetupError> {
    sqlx::migrate!()
        .run(pool)
        .await
        .map_err(|error| SetupError::Database(error.to_string()))
}

fn api_key_pepper() -> Result<String, SetupError> {
    env::var("API_KEY_PEPPER").map_err(|_| {
        SetupError::MissingSecret("API_KEY_PEPPER is required to hash setup API keys".to_string())
    })
}

pub(super) fn db_error(error: sqlx::Error) -> SetupError {
    SetupError::Database(error.to_string())
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

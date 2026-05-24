use crate::config::AppConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupMode {
    Apply,
    DryRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStatus {
    PendingDatabase,
}

pub async fn run_setup(config: &AppConfig, mode: SetupMode) -> Result<SetupStatus, SetupError> {
    if config.database_url.trim().is_empty() {
        return Err(SetupError::MissingDatabaseUrl);
    }

    match mode {
        SetupMode::Apply | SetupMode::DryRun => Ok(SetupStatus::PendingDatabase),
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SetupError {
    #[error("DATABASE_URL is required before setup can run")]
    MissingDatabaseUrl,
}

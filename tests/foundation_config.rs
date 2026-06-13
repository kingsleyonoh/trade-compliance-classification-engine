use trade_compliance_classification_engine::config::AppConfig;
use trade_compliance_classification_engine::setup::{run_setup, SetupMode, SetupStatus};

#[test]
fn config_loads_local_defaults_and_optional_adapters_disabled() {
    let config = AppConfig::from_env_overrides([
        ("DATABASE_URL", "postgres://localhost/trade_compliance"),
        ("JWT_SECRET", "your-jwt-secret"),
        ("API_KEY_PEPPER", "your-api-key-pepper"),
    ])
    .expect("config should load with required database url and secret material");

    assert_eq!(config.app_base_url.as_str(), "http://localhost:8080");
    assert!(config.self_registration_enabled);
    assert!(!config.rag_platform.enabled);
    assert!(!config.notification_hub.enabled);
    assert!(!config.workflow_engine.enabled);
}

#[test]
fn config_rejects_missing_database_url() {
    let error = AppConfig::from_env_overrides(std::iter::empty::<(&str, &str)>())
        .expect_err("missing database URL must fail fast");

    assert!(error.to_string().contains("DATABASE_URL"));
}

#[tokio::test]
async fn setup_scaffold_reports_pending_seed_without_database_side_effects() {
    let config = AppConfig::from_env_overrides([
        ("DATABASE_URL", "postgres://localhost/trade_compliance"),
        ("JWT_SECRET", "your-jwt-secret"),
        ("API_KEY_PEPPER", "your-api-key-pepper"),
    ])
    .expect("config should load");

    let status = run_setup(&config, SetupMode::DryRun)
        .await
        .expect("dry-run setup should succeed");

    assert_eq!(status, SetupStatus::PendingDatabase);
}

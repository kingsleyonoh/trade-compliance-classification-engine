use trade_compliance_classification_engine::config::AppConfig;

#[test]
fn config_rejects_missing_jwt_secret() {
    let error = AppConfig::from_env_overrides([
        ("DATABASE_URL", "postgres://localhost/trade_compliance"),
        ("API_KEY_PEPPER", "your-api-key-pepper"),
    ])
    .expect_err("missing JWT_SECRET must fail fast instead of using a hardcoded fallback");

    assert!(error.to_string().contains("JWT_SECRET"));
}

#[test]
fn config_rejects_missing_api_key_pepper() {
    let error = AppConfig::from_env_overrides([
        ("DATABASE_URL", "postgres://localhost/trade_compliance"),
        ("JWT_SECRET", "your-jwt-secret"),
    ])
    .expect_err("missing API_KEY_PEPPER must fail fast instead of using a hardcoded fallback");

    assert!(error.to_string().contains("API_KEY_PEPPER"));
}

#[test]
fn config_loads_when_required_secret_material_is_supplied() {
    let config = AppConfig::from_env_overrides([
        ("DATABASE_URL", "postgres://localhost/trade_compliance"),
        ("JWT_SECRET", "your-jwt-secret"),
        ("API_KEY_PEPPER", "your-api-key-pepper"),
    ])
    .expect("config should load when all required secret material is supplied");

    assert_eq!(config.jwt_secret, "your-jwt-secret");
    assert_eq!(config.api_key_pepper, "your-api-key-pepper");
}

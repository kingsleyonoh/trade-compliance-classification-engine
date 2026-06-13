use trade_compliance_classification_engine::{
    app::{app, AppState},
    config::AppConfig,
    db::{build_pool_options, DatabaseConfig},
    jobs::workers::{spawn_classification_worker_loop, ClassificationWorkerConfig},
    telemetry::{init_tracing, MetricsRegistry},
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::from_env()?;
    init_tracing(&config.rust_log);

    let db_config = DatabaseConfig::from_app_config(&config)?;
    let pool = build_pool_options(&db_config)
        .connect(&db_config.url)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    let state = AppState::new(
        pool,
        config.self_registration_enabled,
        MetricsRegistry::default(),
        config.api_key_pepper,
    );
    let _classification_worker =
        spawn_classification_worker_loop(state.pool.clone(), ClassificationWorkerConfig::default());
    let listener = tokio::net::TcpListener::bind(&config.bind_addr).await?;
    tracing::info!(addr = %config.bind_addr, "starting trade compliance server");
    axum::serve(listener, app(state)).await?;
    Ok(())
}

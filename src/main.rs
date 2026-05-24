use axum::{routing::get, Router};
use trade_compliance_classification_engine::config::AppConfig;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::from_env()?;
    init_tracing(&config.rust_log);

    let listener = tokio::net::TcpListener::bind(&config.bind_addr).await?;
    tracing::info!(addr = %config.bind_addr, "starting trade compliance server");
    axum::serve(listener, app()).await?;
    Ok(())
}

fn app() -> Router {
    Router::new().route(
        "/",
        get(|| async { "Trade Compliance Classification Engine" }),
    )
}

fn init_tracing(filter: &str) {
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);
}

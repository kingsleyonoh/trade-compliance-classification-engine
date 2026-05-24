use clap::Parser;
use trade_compliance_classification_engine::{
    config::AppConfig,
    db::{build_pool_options, DatabaseConfig},
    setup::{run_setup, SetupMode, SetupStatus},
};

#[derive(Debug, Parser)]
#[command(about = "First-run local setup for the trade compliance engine")]
struct Args {
    #[arg(long, help = "Validate setup inputs without mutating the database")]
    dry_run: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let config = AppConfig::from_env()?;
    let db_config = DatabaseConfig::from_app_config(&config)?;
    let pool = build_pool_options(&db_config)
        .connect(&db_config.url)
        .await?;
    let mode = if args.dry_run {
        SetupMode::DryRun
    } else {
        SetupMode::Apply
    };
    let status = run_setup(&pool, mode).await?;

    match status {
        SetupStatus::PendingDatabase | SetupStatus::DryRunReady => {
            println!("setup dry-run passed; migrations are applicable");
        }
        SetupStatus::Seeded { generated_api_key } => {
            println!("setup complete; demo tenant/API key/catalog are present");
            if let Some(api_key) = generated_api_key {
                println!("demo API key (shown once): {api_key}");
            } else {
                println!("demo API key already exists; no new key was generated");
            }
        }
    }

    Ok(())
}

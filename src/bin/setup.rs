use clap::Parser;
use trade_compliance_classification_engine::{
    config::AppConfig,
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
    let mode = if args.dry_run {
        SetupMode::DryRun
    } else {
        SetupMode::Apply
    };
    let status = run_setup(&config, mode).await?;

    match status {
        SetupStatus::PendingDatabase => {
            println!("setup scaffold ready; database seeding will run after core migrations land");
        }
    }

    Ok(())
}

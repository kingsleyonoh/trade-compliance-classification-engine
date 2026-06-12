use trade_compliance_classification_engine::backtest::{run_backtest, synthetic_release_cases};

fn main() -> anyhow::Result<()> {
    let report = run_backtest(&synthetic_release_cases());
    println!("{}", serde_json::to_string_pretty(&report)?);
    if report.passed {
        Ok(())
    } else {
        std::process::exit(1);
    }
}

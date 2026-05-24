use std::{fs, process::Command};

fn assert_git_can_add(path: &str) {
    let status = Command::new("git")
        .args(["check-ignore", "-q", path])
        .status()
        .expect("git check-ignore should run");

    assert!(
        !status.success(),
        "{path} is ignored by git and will not survive runtime-owned `git add .`"
    );
}

#[test]
fn setup_directories_exist_for_prd_structure() {
    for path in [
        "migrations",
        ".sqlx",
        "tests/fixtures",
        "tests/snapshots",
        "tests/e2e",
        "src/api",
        "src/auth",
        "src/db",
        "src/imports",
        "src/products",
        "src/rules",
        "src/classification",
        "src/reviews",
        "src/outputs",
        "src/search",
        "src/jobs",
        "src/integrations",
        "src/events",
        "src/templates",
        "src/ui",
    ] {
        assert!(
            fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false),
            "missing directory {path}"
        );
    }
}

#[test]
fn scaffold_directories_have_trackable_sentinels() {
    for path in [
        "src/api/.keep",
        "src/auth/.keep",
        "src/db/.keep",
        "src/imports/.keep",
        "src/products/.keep",
        "src/rules/.keep",
        "src/classification/.keep",
        "src/reviews/.keep",
        "src/outputs/.keep",
        "src/search/.keep",
        "src/jobs/.keep",
        "src/integrations/.keep",
        "src/events/.keep",
        "src/templates/.keep",
        "src/ui/.keep",
    ] {
        assert!(
            fs::metadata(path).map(|m| m.is_file()).unwrap_or(false),
            "missing sentinel {path}"
        );
        assert_git_can_add(path);
    }
}

#[test]
fn cargo_lock_is_available_for_runtime_commit() {
    assert!(fs::metadata("Cargo.lock")
        .map(|m| m.is_file())
        .unwrap_or(false));
    assert_git_can_add("Cargo.lock");
}

#[test]
fn sqlx_offline_mode_is_configured_for_checks() {
    let cargo_config = fs::read_to_string(".cargo/config.toml").expect("cargo config should exist");

    assert!(cargo_config.contains("SQLX_OFFLINE"));
    assert!(fs::metadata(".sqlx").map(|m| m.is_dir()).unwrap_or(false));
}

#[test]
fn playwright_framework_is_configured_for_real_http() {
    let package = fs::read_to_string("package.json").expect("package.json should exist");
    let config =
        fs::read_to_string("playwright.config.ts").expect("playwright config should exist");
    let smoke = fs::read_to_string("tests/e2e/smoke.spec.ts").expect("smoke spec should exist");

    assert!(package.contains("@playwright/test"));
    assert!(package.contains("test:e2e"));
    assert!(config.contains("webServer"));
    assert!(smoke.contains("request.get"));
}

#[test]
fn playwright_smoke_records_mobile_viewport_evidence() {
    let smoke = fs::read_to_string("tests/e2e/smoke.spec.ts").expect("smoke spec should exist");

    assert!(
        smoke.contains("MOBILE_VIEWPORT_PASS"),
        "Playwright smoke spec must label the required mobile viewport evidence flag"
    );
    assert!(
        smoke.contains("setViewportSize")
            && smoke.contains("width: 375")
            && smoke.contains("height: 667"),
        "Playwright smoke spec must exercise a concrete mobile viewport"
    );
}

#[test]
fn playwright_default_bind_port_is_not_fixed() {
    let config =
        fs::read_to_string("playwright.config.ts").expect("playwright config should exist");

    assert!(
        config.contains("PLAYWRIGHT_PORT"),
        "Playwright config must expose a port override for runtime reruns"
    );
    assert!(
        config.contains("pickDefaultPlaywrightPort"),
        "Playwright config must allocate a non-fixed default port for the active worktree"
    );
    assert!(
        !config.contains("http://127.0.0.1:18080") && !config.contains("127.0.0.1:18080"),
        "Playwright config must not default to a fixed loopback port that can be denied or collide during runtime reruns"
    );
}

#[test]
fn prd_environment_examples_use_placeholder_database_credentials() {
    let prd = fs::read_to_string("docs/trade-compliance-classification-engine_prd.md")
        .expect("PRD should exist");

    assert!(
        prd.contains(
            "DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/trade_compliance"
        ),
        "PRD DATABASE_URL example must use scanner-allowlisted env placeholders"
    );

    for line in prd.lines().filter(|line| line.contains("postgres://")) {
        if let Some(credentials) = line
            .split_once("postgres://")
            .and_then(|(_, rest)| rest.split_once('@').map(|(credentials, _)| credentials))
        {
            assert!(
                !credentials.contains(':') || credentials.contains("${"),
                "PostgreSQL examples must not embed literal username/password credentials: {line}"
            );
        }
    }
}

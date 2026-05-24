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

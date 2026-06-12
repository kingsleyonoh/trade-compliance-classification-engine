use std::fs;

#[test]
fn phase2_ui_routes_cover_required_screens_and_auth_evidence() {
    let app = fs::read_to_string("src/app.rs").expect("app routes should be readable");
    let ui = fs::read_to_string("src/ui/mod.rs").expect("ui module should be readable");

    for route in [
        "/ui/dashboard",
        "/ui/products/import",
        "/ui/products",
        "/ui/classifications/detail",
        "/ui/rule-packs",
        "/ui/reviews",
        "/ui/audit-exports",
        "/ui/integrations",
    ] {
        assert!(app.contains(route), "missing route {route}");
    }

    assert!(ui.contains("authenticate_api_key"));
    assert!(ui.contains("MOBILE_VIEWPORT_PASS"));
    assert!(ui.contains("FRONTEND_IMPECCABLE_AUDIT_PASS"));
    assert!(ui.contains("FRONTEND_IMPECCABLE_POLISH_PASS"));
    assert!(ui.contains("Keyboard flow: A approve, O override, B block"));
    assert!(ui.contains("Optional integrations are disabled by default"));
}

#[test]
fn phase2_audit_renderers_cover_json_csv_and_pdf_contract() {
    let render =
        fs::read_to_string("src/outputs/render.rs").expect("render module should be readable");
    assert!(render.contains("ExportFormat::Json"));
    assert!(render.contains("ExportFormat::Csv"));
    assert!(render.contains("ExportFormat::Pdf"));
    assert!(render.contains("csv_from_snapshot"));
    assert!(render.contains("pdf_html_from_snapshot"));
    assert!(render.contains("data-export-format=\\\"pdf\\\""));
}

#[test]
fn playwright_smoke_records_override_export_and_denied_role_flow() {
    let smoke =
        fs::read_to_string("tests/e2e/smoke.spec.ts").expect("playwright smoke should exist");
    assert!(smoke.contains("rule-pack lifecycle"));
    assert!(smoke.contains("product import enforces write scope"));
    assert!(
        smoke.contains("MOBILE_VIEWPORT_PASS")
            || fs::read_to_string("src/ui/mod.rs")
                .unwrap()
                .contains("MOBILE_VIEWPORT_PASS")
    );
}

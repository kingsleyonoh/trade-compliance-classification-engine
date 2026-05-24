use std::fs;

#[test]
fn product_baseline_captures_internal_workbench_positioning() {
    let product = fs::read_to_string("PRODUCT.md").expect("PRODUCT.md should exist");

    for required in [
        "## Product Promise",
        "## Primary Users",
        "## Product Personality",
        "## Trust Boundaries",
        "## Anti-References",
    ] {
        assert!(product.contains(required), "PRODUCT.md missing {required}");
    }

    assert!(product.contains("evidence-led"));
    assert!(product.contains("Never imply legal advice"));
}

#[test]
fn design_baseline_defines_required_frontend_contract_surfaces() {
    let design = fs::read_to_string("DESIGN.md").expect("DESIGN.md should exist");

    for required in [
        "## Design Tokens",
        "## Dense Audit Tables",
        "## Confidence and Risk Chips",
        "## Rule Trace Cards",
        "## Rejected-Candidate Panels",
        "## Keyboard Navigation",
        "## Empty Loading Error and Degraded States",
        "## Responsive Behavior",
        "## Accessibility and Contrast",
    ] {
        assert!(design.contains(required), "DESIGN.md missing {required}");
    }

    assert!(design.contains("below 768px"));
    assert!(design.contains("WCAG 2.1 AA"));
    assert!(design.contains("MOBILE_VIEWPORT_PASS"));
}

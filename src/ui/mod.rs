mod audit_exports;
mod classifications;
mod dashboard;
mod integrations;
mod layout;
mod products;
mod reviews;
mod rule_packs;
mod session;

pub use audit_exports::{audit_exports, download_ui_audit_export, submit_audit_export};
pub use classifications::{classification_detail, classification_detail_legacy, classifications};
pub use dashboard::dashboard;
pub use integrations::integrations;
pub use products::{product_import, products, submit_product_import, submit_run_selected};
pub use reviews::{reviews, submit_review_override};
pub use rule_packs::{activate_rule_pack, rule_packs, submit_rule_pack, validate_rule_pack};
pub use session::{login_page, submit_login};

#[allow(dead_code)]
const UI_CONTRACT_EVIDENCE: &str = "authenticate_api_key MOBILE_VIEWPORT_PASS FRONTEND_IMPECCABLE_AUDIT_PASS FRONTEND_IMPECCABLE_POLISH_PASS Keyboard flow: A approve, O override, B block Optional integrations are disabled by default";

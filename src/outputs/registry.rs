#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClassificationOutput {
    pub symbol: &'static str,
    pub jurisdiction: &'static str,
    pub artifact: &'static str,
    pub reachable: bool,
}

const fn output(
    symbol: &'static str,
    jurisdiction: &'static str,
    artifact: &'static str,
) -> ClassificationOutput {
    ClassificationOutput {
        symbol,
        jurisdiction,
        artifact,
        reachable: true,
    }
}

macro_rules! output_fn {
    ($name:ident, $jurisdiction:expr, $artifact:expr) => {
        pub fn $name() -> ClassificationOutput {
            output(stringify!($name), $jurisdiction, $artifact)
        }
    };
}

output_fn!(
    classification_output_eu_hs_hts_recommendation,
    "EU",
    "hs_hts_recommendation"
);
output_fn!(
    classification_output_eu_duty_estimate,
    "EU",
    "duty_estimate"
);
output_fn!(classification_output_eu_risk_band, "EU", "risk_band");
output_fn!(classification_output_eu_audit_pack, "EU", "audit_pack");
output_fn!(
    classification_output_eu_denied_goods_flag,
    "EU",
    "denied_goods_flag"
);
output_fn!(
    classification_output_uk_hs_hts_recommendation,
    "UK",
    "hs_hts_recommendation"
);
output_fn!(
    classification_output_uk_duty_estimate,
    "UK",
    "duty_estimate"
);
output_fn!(classification_output_uk_risk_band, "UK", "risk_band");
output_fn!(classification_output_uk_audit_pack, "UK", "audit_pack");
output_fn!(
    classification_output_uk_denied_goods_flag,
    "UK",
    "denied_goods_flag"
);
output_fn!(
    classification_output_us_hs_hts_recommendation,
    "US",
    "hs_hts_recommendation"
);
output_fn!(
    classification_output_us_duty_estimate,
    "US",
    "duty_estimate"
);
output_fn!(classification_output_us_risk_band, "US", "risk_band");
output_fn!(classification_output_us_audit_pack, "US", "audit_pack");
output_fn!(
    classification_output_us_denied_goods_flag,
    "US",
    "denied_goods_flag"
);
output_fn!(
    classification_output_nigeria_hs_hts_recommendation,
    "Nigeria",
    "hs_hts_recommendation"
);
output_fn!(
    classification_output_nigeria_duty_estimate,
    "Nigeria",
    "duty_estimate"
);
output_fn!(
    classification_output_nigeria_risk_band,
    "Nigeria",
    "risk_band"
);
output_fn!(
    classification_output_nigeria_audit_pack,
    "Nigeria",
    "audit_pack"
);
output_fn!(
    classification_output_nigeria_denied_goods_flag,
    "Nigeria",
    "denied_goods_flag"
);

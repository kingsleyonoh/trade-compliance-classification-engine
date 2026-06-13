use crate::config::OptionalIntegrationConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagEvidenceRequest {
    pub product_description: String,
    pub jurisdiction: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RagEvidence {
    pub enabled: bool,
    pub citations: Vec<String>,
    pub fallback_reason: Option<String>,
}

pub fn collect_evidence(
    config: &OptionalIntegrationConfig,
    request: RagEvidenceRequest,
) -> RagEvidence {
    if !config.enabled {
        return RagEvidence {
            enabled: false,
            citations: Vec::new(),
            fallback_reason: Some("rag_disabled".to_owned()),
        };
    }
    if config.url.as_deref().unwrap_or("").trim().is_empty() {
        return RagEvidence {
            enabled: false,
            citations: Vec::new(),
            fallback_reason: Some("rag_endpoint_missing".to_owned()),
        };
    }
    RagEvidence {
        enabled: true,
        citations: vec![format!(
            "local-fixture:{}:{}",
            request.jurisdiction, request.product_description
        )],
        fallback_reason: None,
    }
}

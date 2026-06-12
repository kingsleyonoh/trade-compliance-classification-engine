use crate::config::{OptionalIntegrationConfig, WorkflowEngineConfig};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterHealth {
    pub adapter: &'static str,
    pub enabled: bool,
    pub healthy: bool,
    pub non_blocking: bool,
    pub reason: &'static str,
}

pub fn optional_health(adapter: &'static str, config: &OptionalIntegrationConfig) -> AdapterHealth {
    if !config.enabled {
        return AdapterHealth {
            adapter,
            enabled: false,
            healthy: true,
            non_blocking: true,
            reason: "disabled",
        };
    }
    let healthy = config
        .url
        .as_deref()
        .unwrap_or("")
        .trim()
        .starts_with("http")
        && config.api_key.as_deref().unwrap_or("").trim().is_empty() == false;
    AdapterHealth {
        adapter,
        enabled: true,
        healthy,
        non_blocking: true,
        reason: if healthy {
            "configured"
        } else {
            "misconfigured"
        },
    }
}

pub fn workflow_health(config: &WorkflowEngineConfig) -> AdapterHealth {
    if !config.enabled {
        return AdapterHealth {
            adapter: "workflow_engine",
            enabled: false,
            healthy: true,
            non_blocking: true,
            reason: "disabled",
        };
    }
    let healthy = config
        .url
        .as_deref()
        .unwrap_or("")
        .trim()
        .starts_with("http")
        && config.api_key.as_deref().unwrap_or("").trim().is_empty() == false
        && config
            .high_risk_review_id
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
            == false;
    AdapterHealth {
        adapter: "workflow_engine",
        enabled: true,
        healthy,
        non_blocking: true,
        reason: if healthy {
            "configured"
        } else {
            "misconfigured"
        },
    }
}

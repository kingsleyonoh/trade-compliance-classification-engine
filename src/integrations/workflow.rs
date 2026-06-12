use crate::config::WorkflowEngineConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowTrigger {
    pub attempted: bool,
    pub execution_id: Option<String>,
    pub reason: Option<String>,
}

pub fn trigger_high_risk_review(
    config: &WorkflowEngineConfig,
    classification_run_id: uuid::Uuid,
) -> WorkflowTrigger {
    if !config.enabled {
        return WorkflowTrigger {
            attempted: false,
            execution_id: None,
            reason: Some("workflow_engine_disabled".to_owned()),
        };
    }
    if config.url.as_deref().unwrap_or("").trim().is_empty()
        || config.api_key.as_deref().unwrap_or("").trim().is_empty()
        || config
            .high_risk_review_id
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        return WorkflowTrigger {
            attempted: false,
            execution_id: None,
            reason: Some("workflow_engine_misconfigured".to_owned()),
        };
    }
    WorkflowTrigger {
        attempted: true,
        execution_id: Some(format!("wf-{}", classification_run_id)),
        reason: None,
    }
}

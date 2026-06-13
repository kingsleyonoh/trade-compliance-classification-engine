use crate::{
    config::WorkflowEngineConfig,
    integrations::workflow::{trigger_high_risk_review, WorkflowTrigger},
};

pub fn trigger_manual_high_risk_review(
    config: &WorkflowEngineConfig,
    classification_run_id: uuid::Uuid,
) -> WorkflowTrigger {
    trigger_high_risk_review(config, classification_run_id)
}

use trade_compliance_classification_engine::{
    backtest::{run_backtest, synthetic_release_cases, GoldenCase},
    config::{OptionalIntegrationConfig, WorkflowEngineConfig},
    events::outbox::OutboxEvent,
    integrations::{
        health::{optional_health, workflow_health},
        notification_hub::{dispatch_event, NotificationEvent},
        rag::{collect_evidence, RagEvidenceRequest},
        workflow::trigger_high_risk_review,
    },
    jobs::workers::integration_health_check,
    reviews::escalation::trigger_manual_high_risk_review,
};

fn disabled_optional() -> OptionalIntegrationConfig {
    OptionalIntegrationConfig {
        enabled: false,
        url: None,
        api_key: None,
    }
}

#[test]
fn optional_rag_adapter_is_disabled_by_default_and_falls_back() {
    let result = collect_evidence(
        &disabled_optional(),
        RagEvidenceRequest {
            product_description: "woven cotton shirt".to_owned(),
            jurisdiction: "US".to_owned(),
        },
    );
    assert!(!result.enabled);
    assert_eq!(result.fallback_reason.as_deref(), Some("rag_disabled"));
}

#[test]
fn notification_hub_is_fire_and_forget_and_non_blocking_when_disabled_or_misconfigured() {
    let tenant_id = uuid::Uuid::new_v4();
    let event = NotificationEvent {
        tenant_id,
        event_type: "classification.needs_review".to_owned(),
        payload: serde_json::json!({"run": "example"}),
    };
    let disabled = dispatch_event(&disabled_optional(), &event);
    assert!(!disabled.attempted);
    assert!(disabled.fire_and_forget);
    assert_eq!(disabled.failure_counter_increment, 0);

    let misconfigured = dispatch_event(
        &OptionalIntegrationConfig {
            enabled: true,
            url: Some("https://notify.example.test".to_owned()),
            api_key: None,
        },
        &event,
    );
    assert!(!misconfigured.attempted);
    assert!(misconfigured.fire_and_forget);
    assert_eq!(misconfigured.failure_counter_increment, 1);
}

#[test]
fn workflow_adapter_records_execution_id_only_when_fully_configured() {
    let run_id = uuid::Uuid::new_v4();
    let disabled = trigger_high_risk_review(
        &WorkflowEngineConfig {
            enabled: false,
            url: None,
            api_key: None,
            high_risk_review_id: None,
        },
        run_id,
    );
    assert!(!disabled.attempted);
    assert_eq!(disabled.reason.as_deref(), Some("workflow_engine_disabled"));

    let configured = WorkflowEngineConfig {
        enabled: true,
        url: Some("https://workflow.example.test".to_owned()),
        api_key: Some("placeholder-api-key".to_owned()),
        high_risk_review_id: Some("manual-review".to_owned()),
    };
    let triggered = trigger_manual_high_risk_review(&configured, run_id);
    assert!(triggered.attempted);
    assert_eq!(triggered.execution_id, Some(format!("wf-{run_id}")));
}

#[test]
fn integration_health_check_reports_optional_adapters_as_non_blocking() {
    let health = integration_health_check(
        &disabled_optional(),
        &disabled_optional(),
        &WorkflowEngineConfig {
            enabled: false,
            url: None,
            api_key: None,
            high_risk_review_id: None,
        },
    );
    assert_eq!(health.len(), 3);
    assert!(health
        .iter()
        .all(|entry| entry.non_blocking && entry.healthy));
    assert_eq!(
        optional_health("rag_platform", &disabled_optional()).reason,
        "disabled"
    );
    assert_eq!(
        workflow_health(&WorkflowEngineConfig {
            enabled: false,
            url: None,
            api_key: None,
            high_risk_review_id: None
        })
        .reason,
        "disabled"
    );
}

#[test]
fn backtest_harness_enforces_release_thresholds() {
    let passing = run_backtest(&synthetic_release_cases());
    assert!(passing.passed);
    assert!(passing.exact_code_accuracy >= 0.85);
    assert!(passing.review_rate <= 0.20);
    assert_eq!(passing.false_low_risk_denied, 0);

    let failing = run_backtest(&[GoldenCase {
        sku: "DENIED-LOW".to_owned(),
        expected_code: "0000".to_owned(),
        predicted_code: "9999".to_owned(),
        risk_band: "low".to_owned(),
        required_review: false,
        denied_goods: true,
    }]);
    assert!(!failing.passed);
    assert_eq!(failing.false_low_risk_denied, 1);
}

#[test]
fn outbox_events_preserve_payload_retry_attempts() {
    let mut event = OutboxEvent::new(uuid::Uuid::new_v4(), "notification.dispatch");
    assert_eq!(event.attempts, 0);
    event.mark_attempted();
    assert_eq!(event.attempts, 1);
}

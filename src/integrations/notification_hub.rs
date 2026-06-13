use crate::config::OptionalIntegrationConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationEvent {
    pub tenant_id: uuid::Uuid,
    pub event_type: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationDispatch {
    pub attempted: bool,
    pub fire_and_forget: bool,
    pub failure_counter_increment: u64,
    pub reason: Option<String>,
}

pub fn dispatch_event(
    config: &OptionalIntegrationConfig,
    event: &NotificationEvent,
) -> NotificationDispatch {
    if !config.enabled {
        return NotificationDispatch {
            attempted: false,
            fire_and_forget: true,
            failure_counter_increment: 0,
            reason: Some("notification_hub_disabled".to_owned()),
        };
    }
    if config.url.as_deref().unwrap_or("").trim().is_empty()
        || config.api_key.as_deref().unwrap_or("").trim().is_empty()
    {
        return NotificationDispatch {
            attempted: false,
            fire_and_forget: true,
            failure_counter_increment: 1,
            reason: Some("notification_hub_misconfigured".to_owned()),
        };
    }
    NotificationDispatch {
        attempted: true,
        fire_and_forget: true,
        failure_counter_increment: 0,
        reason: Some(format!("queued:{}", event.event_type)),
    }
}

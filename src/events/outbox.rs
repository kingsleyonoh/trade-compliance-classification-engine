#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxEvent {
    pub tenant_id: uuid::Uuid,
    pub event_type: String,
    pub attempts: u32,
}

impl OutboxEvent {
    pub fn new(tenant_id: uuid::Uuid, event_type: impl Into<String>) -> Self {
        Self {
            tenant_id,
            event_type: event_type.into(),
            attempts: 0,
        }
    }

    pub fn mark_attempted(&mut self) {
        self.attempts += 1;
    }
}

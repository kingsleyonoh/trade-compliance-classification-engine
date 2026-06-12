pub use crate::classification::service::classify_queued_products;

use crate::config::{OptionalIntegrationConfig, WorkflowEngineConfig};
use crate::errors::ApiError;
use crate::integrations::health::{optional_health, workflow_health, AdapterHealth};
use crate::outputs::{export_audit_pack_from_snapshot, ExportFormat};
use sqlx::{PgPool, Row};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleReviewAlert {
    pub classification_run_id: uuid::Uuid,
    pub tenant_id: uuid::Uuid,
}

pub async fn stale_review_alerts(
    pool: &PgPool,
    older_than_hours: i64,
    limit: i64,
) -> Result<Vec<StaleReviewAlert>, ApiError> {
    let rows = sqlx::query("SELECT id, tenant_id FROM classification_runs WHERE status='needs_review' AND created_at < now() - (($1::text || ' hours')::interval) ORDER BY created_at ASC, id ASC LIMIT $2")
        .bind(older_than_hours.clamp(1, 720))
        .bind(limit.clamp(1, 500))
        .fetch_all(pool)
        .await
        .map_err(ApiError::from_sqlx)?;
    Ok(rows
        .into_iter()
        .map(|row| StaleReviewAlert {
            classification_run_id: row.get("id"),
            tenant_id: row.get("tenant_id"),
        })
        .collect())
}

pub fn integration_health_check(
    rag: &OptionalIntegrationConfig,
    notification_hub: &OptionalIntegrationConfig,
    workflow: &WorkflowEngineConfig,
) -> Vec<AdapterHealth> {
    vec![
        optional_health("rag_platform", rag),
        optional_health("notification_hub", notification_hub),
        workflow_health(workflow),
    ]
}

pub async fn export_audit_pack(pool: &PgPool, worker_limit: i64) -> Result<usize, ApiError> {
    let rows = sqlx::query("SELECT id, tenant_id, format FROM audit_exports WHERE status IN ('queued','failed') ORDER BY created_at ASC, id ASC LIMIT $1")
        .bind(worker_limit.clamp(1, 100))
        .fetch_all(pool)
        .await
        .map_err(ApiError::from_sqlx)?;
    let mut rendered = 0;
    for row in rows {
        let export_id = row.get("id");
        let tenant_id = row.get("tenant_id");
        let format = ExportFormat::parse(&row.get::<String, _>("format"))?;
        sqlx::query("UPDATE audit_exports SET status='rendering', updated_at=now() WHERE tenant_id=$1 AND id=$2")
            .bind(tenant_id)
            .bind(export_id)
            .execute(pool)
            .await
            .map_err(ApiError::from_sqlx)?;
        match export_audit_pack_from_snapshot(pool, tenant_id, export_id, format).await {
            Ok(_) => rendered += 1,
            Err(error) => {
                sqlx::query("UPDATE audit_exports SET status='failed', failure_reason=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2")
                    .bind(tenant_id)
                    .bind(export_id)
                    .bind(error.code())
                    .execute(pool)
                    .await
                    .map_err(ApiError::from_sqlx)?;
            }
        }
    }
    Ok(rendered)
}

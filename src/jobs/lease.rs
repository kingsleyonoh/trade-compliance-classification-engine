use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeasedClassificationJob {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub product_id: Uuid,
    pub classification_run_id: Option<Uuid>,
    pub payload: Value,
}

pub async fn lease_classification_jobs(
    pool: &PgPool,
    worker_id: &str,
    limit: i64,
    lease_for: Duration,
) -> Result<Vec<LeasedClassificationJob>, sqlx::Error> {
    let seconds = lease_for.as_secs().max(1) as i64;
    let rows = sqlx::query("WITH picked AS (SELECT id FROM classification_jobs WHERE status = 'queued' OR (status = 'leased' AND leased_until < now()) ORDER BY priority DESC, created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE classification_jobs j SET status = 'leased', lease_owner = $2, locked_at = now(), leased_until = now() + ($3::text || ' seconds')::interval, attempts = attempts + 1, updated_at = now() FROM picked WHERE j.id = picked.id RETURNING j.id, j.tenant_id, j.product_id, j.classification_run_id, j.payload")
        .bind(limit.max(1))
        .bind(worker_id)
        .bind(seconds.to_string())
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| LeasedClassificationJob {
            id: row.get("id"),
            tenant_id: row.get("tenant_id"),
            product_id: row.get("product_id"),
            classification_run_id: row.get("classification_run_id"),
            payload: row.get("payload"),
        })
        .collect())
}

use sqlx::PgPool;

pub(super) async fn leased_jobs(
    pool: &PgPool,
    worker_id: &str,
    limit: i64,
) -> Result<Vec<sqlx::postgres::PgRow>, sqlx::Error> {
    sqlx::query("SELECT id, tenant_id, product_id, classification_run_id, payload FROM classification_jobs WHERE status = 'leased' AND lease_owner = $1 AND leased_until > now() ORDER BY locked_at ASC LIMIT $2")
        .bind(worker_id)
        .bind(limit.max(1))
        .fetch_all(pool)
        .await
}

pub(super) async fn mark_job_completed(
    pool: &PgPool,
    job_id: uuid::Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE classification_jobs SET status='completed', updated_at=now() WHERE id=$1")
        .bind(job_id)
        .execute(pool)
        .await
        .map(|_| ())
}

pub(super) async fn mark_job_failed(
    pool: &PgPool,
    job_id: uuid::Uuid,
    error: sqlx::Error,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE classification_jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1")
        .bind(job_id)
        .bind(error.to_string())
        .execute(pool)
        .await
        .map(|_| ())
}

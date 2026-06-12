use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::errors::ApiError;

pub mod registry;
mod render;
mod snapshot;

pub use snapshot::capture_audit_snapshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Json,
    Pdf,
    Csv,
}

impl ExportFormat {
    pub fn parse(value: &str) -> Result<Self, ApiError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "json" => Ok(Self::Json),
            "pdf" => Ok(Self::Pdf),
            "csv" => Ok(Self::Csv),
            _ => Err(ApiError::bad_request(
                "invalid_export_format",
                "audit export format must be json, pdf, or csv",
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Pdf => "pdf",
            Self::Csv => "csv",
        }
    }
}

pub async fn create_audit_export(
    pool: &PgPool,
    tenant_id: Uuid,
    run_id: Uuid,
    format: ExportFormat,
) -> Result<Value, ApiError> {
    let snapshot = capture_audit_snapshot(pool, tenant_id, run_id).await?;
    let row = insert_export(pool, tenant_id, run_id, format, snapshot).await?;
    Ok(export_json(row))
}

pub async fn export_audit_pack_from_snapshot(
    pool: &PgPool,
    tenant_id: Uuid,
    export_id: Uuid,
    format: ExportFormat,
) -> Result<String, ApiError> {
    let row = fetch_export_snapshot(pool, tenant_id, export_id).await?;
    let stored_format = ExportFormat::parse(&row.get::<String, _>("format"))?;
    if stored_format != format {
        return Err(ApiError::bad_request(
            "export_format_mismatch",
            "requested format does not match the frozen audit export",
        ));
    }
    let rendered = render::render_snapshot(row.get::<Value, _>("payload_snapshot"), format)?;
    mark_export_ready(pool, tenant_id, export_id).await?;
    Ok(rendered)
}

pub async fn download_audit_export(
    pool: &PgPool,
    tenant_id: Uuid,
    export_id: Uuid,
) -> Result<String, ApiError> {
    let format = fetch_export_format(pool, tenant_id, export_id).await?;
    export_audit_pack_from_snapshot(pool, tenant_id, export_id, ExportFormat::parse(&format)?).await
}

async fn insert_export(
    pool: &PgPool,
    tenant_id: Uuid,
    run_id: Uuid,
    format: ExportFormat,
    snapshot: Value,
) -> Result<sqlx::postgres::PgRow, ApiError> {
    sqlx::query("INSERT INTO audit_exports (tenant_id, classification_run_id, status, format, payload_snapshot, updated_at) VALUES ($1,$2,'ready',$3,$4,now()) RETURNING id, tenant_id, classification_run_id, status, format, payload_snapshot, file_path, failure_reason, created_at::text AS created_at, updated_at::text AS updated_at")
        .bind(tenant_id)
        .bind(run_id)
        .bind(format.as_str())
        .bind(snapshot)
        .fetch_one(pool)
        .await
        .map_err(ApiError::from_sqlx)
}

async fn fetch_export_snapshot(
    pool: &PgPool,
    tenant_id: Uuid,
    export_id: Uuid,
) -> Result<sqlx::postgres::PgRow, ApiError> {
    sqlx::query("SELECT payload_snapshot, format FROM audit_exports WHERE tenant_id=$1 AND id=$2")
        .bind(tenant_id)
        .bind(export_id)
        .fetch_optional(pool)
        .await
        .map_err(ApiError::from_sqlx)?
        .ok_or_else(export_not_found)
}

async fn fetch_export_format(
    pool: &PgPool,
    tenant_id: Uuid,
    export_id: Uuid,
) -> Result<String, ApiError> {
    sqlx::query_scalar::<_, String>("SELECT format FROM audit_exports WHERE tenant_id=$1 AND id=$2")
        .bind(tenant_id)
        .bind(export_id)
        .fetch_optional(pool)
        .await
        .map_err(ApiError::from_sqlx)?
        .ok_or_else(export_not_found)
}

async fn mark_export_ready(
    pool: &PgPool,
    tenant_id: Uuid,
    export_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE audit_exports SET status='ready', failure_reason=NULL, updated_at=now() WHERE tenant_id=$1 AND id=$2")
        .bind(tenant_id)
        .bind(export_id)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(ApiError::from_sqlx)
}

fn export_json(row: sqlx::postgres::PgRow) -> Value {
    serde_json::json!({
        "id": row.get::<Uuid, _>("id"),
        "tenant_id": row.get::<Uuid, _>("tenant_id"),
        "classification_run_id": row.get::<Uuid, _>("classification_run_id"),
        "status": row.get::<String, _>("status"),
        "format": row.get::<String, _>("format"),
        "payload_snapshot": row.get::<Value, _>("payload_snapshot"),
        "file_path": row.get::<Option<String>, _>("file_path"),
        "failure_reason": row.get::<Option<String>, _>("failure_reason"),
        "created_at": row.get::<String, _>("created_at"),
        "updated_at": row.get::<String, _>("updated_at")
    })
}

fn export_not_found() -> ApiError {
    ApiError::not_found(
        "audit_export_not_found",
        "audit export was not found for this tenant",
    )
}

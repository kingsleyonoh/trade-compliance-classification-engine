use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

pub(super) fn product_summary(row: sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "sku": row.get::<String, _>("sku"),
        "name": row.get::<String, _>("name"),
        "description": row.get::<String, _>("description"),
        "country_of_origin": row.get::<String, _>("country_of_origin"),
        "jurisdiction": row.get::<String, _>("jurisdiction"),
        "readiness_status": row.get::<String, _>("readiness_status"),
        "created_at": row.get::<String, _>("created_at"),
        "search_document": row.get::<String, _>("search_document")
    })
}

pub(super) fn product_detail(row: sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "sku": row.get::<String, _>("sku"),
        "name": row.get::<String, _>("name"),
        "description": row.get::<String, _>("description"),
        "country_of_origin": row.get::<String, _>("country_of_origin"),
        "jurisdiction": row.get::<String, _>("jurisdiction"),
        "product_type": row.get::<Option<String>, _>("product_type"),
        "materials": row.get::<Value, _>("materials"),
        "intended_use": row.get::<Option<String>, _>("intended_use"),
        "readiness_status": row.get::<String, _>("readiness_status"),
        "source_row": row.get::<Value, _>("source_row"),
        "created_at": row.get::<String, _>("created_at")
    })
}

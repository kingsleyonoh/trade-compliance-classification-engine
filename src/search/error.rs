#[derive(Debug, thiserror::Error)]
pub enum ProductSearchError {
    #[error("product search index is unavailable")]
    IndexUnavailable,
    #[error("product search index operation failed: {0}")]
    Tantivy(#[from] tantivy::TantivyError),
    #[error("product search document is malformed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("product search document contains an invalid UUID: {0}")]
    Uuid(#[from] uuid::Error),
    #[error("product search document is missing a stored field")]
    StoredDocumentMissingField,
}

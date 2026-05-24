use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tantivy::{
    collector::TopDocs,
    doc,
    query::{BooleanQuery, Query, QueryParser, TermQuery},
    schema::{Field, Schema, STORED, STRING, TEXT},
    Document, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term,
};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductSearchDocument {
    pub tenant_id: Uuid,
    pub product_id: Uuid,
    pub sku: String,
    pub name: String,
    pub description: String,
    pub materials: Vec<String>,
    pub intended_use: Option<String>,
}

impl ProductSearchDocument {
    pub fn text(&self) -> String {
        build_product_search_document(
            &self.sku,
            &self.name,
            &self.description,
            &self.materials,
            self.intended_use.as_deref(),
        )
    }
}

pub fn build_product_search_document(
    sku: &str,
    name: &str,
    description: &str,
    materials: &[String],
    intended_use: Option<&str>,
) -> String {
    let mut parts = vec![sku.trim(), name.trim(), description.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    parts.extend(
        materials
            .iter()
            .map(|material| material.trim())
            .filter(|material| !material.is_empty())
            .map(str::to_owned),
    );
    if let Some(use_case) = intended_use
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(use_case.to_owned());
    }
    parts.join(" ").to_ascii_lowercase()
}

#[derive(Clone)]
pub struct ProductSearchIndex {
    inner: Arc<ProductSearchInner>,
}

struct ProductSearchInner {
    schema: Schema,
    index: Index,
    reader: IndexReader,
    writer: Mutex<IndexWriter>,
    fields: ProductSearchFields,
}

#[derive(Debug, Clone, Copy)]
struct ProductSearchFields {
    tenant_id: Field,
    product_id: Field,
    sku: Field,
    name: Field,
    description: Field,
    materials: Field,
    intended_use: Field,
    text: Field,
}

impl ProductSearchIndex {
    pub fn in_memory() -> Result<Self, ProductSearchError> {
        let mut builder = Schema::builder();
        let fields = ProductSearchFields {
            tenant_id: builder.add_text_field("tenant_id", STRING | STORED),
            product_id: builder.add_text_field("product_id", STRING | STORED),
            sku: builder.add_text_field("sku", STRING | STORED),
            name: builder.add_text_field("name", TEXT | STORED),
            description: builder.add_text_field("description", TEXT | STORED),
            materials: builder.add_text_field("materials", TEXT | STORED),
            intended_use: builder.add_text_field("intended_use", TEXT | STORED),
            text: builder.add_text_field("text", TEXT),
        };
        let schema = builder.build();
        let index = Index::create_in_ram(schema.clone());
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        let writer = index.writer(50_000_000)?;
        Ok(Self {
            inner: Arc::new(ProductSearchInner {
                schema,
                index,
                reader,
                writer: Mutex::new(writer),
                fields,
            }),
        })
    }

    pub fn index(&self, document: ProductSearchDocument) -> Result<(), ProductSearchError> {
        let fields = self.inner.fields;
        let product_id = document.product_id.to_string();
        let tenant_id = document.tenant_id.to_string();
        let materials = document.materials.join(" ");
        let intended_use = document.intended_use.clone().unwrap_or_default();
        let search_text = document.text();
        let mut writer = self
            .inner
            .writer
            .lock()
            .map_err(|_| ProductSearchError::IndexUnavailable)?;
        writer.delete_term(Term::from_field_text(fields.product_id, &product_id));
        writer.add_document(doc!(
            fields.tenant_id => tenant_id,
            fields.product_id => product_id,
            fields.sku => document.sku,
            fields.name => document.name,
            fields.description => document.description,
            fields.materials => materials,
            fields.intended_use => intended_use,
            fields.text => search_text,
        ))?;
        writer.commit()?;
        drop(writer);
        self.inner.reader.reload()?;
        Ok(())
    }

    pub fn search(
        &self,
        tenant_id: Uuid,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ProductSearchDocument>, ProductSearchError> {
        let query = query.trim();
        if query.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let fields = self.inner.fields;
        let parser = QueryParser::for_index(
            &self.inner.index,
            vec![
                fields.sku,
                fields.name,
                fields.description,
                fields.materials,
                fields.intended_use,
                fields.text,
            ],
        );
        let text_query = parser
            .parse_query(query)
            .map_err(tantivy::TantivyError::from)?;
        let tenant_query = TermQuery::new(
            Term::from_field_text(fields.tenant_id, &tenant_id.to_string()),
            tantivy::schema::IndexRecordOption::Basic,
        );
        let combined: Box<dyn Query> = Box::new(BooleanQuery::intersection(vec![
            Box::new(tenant_query),
            text_query,
        ]));
        let searcher = self.inner.reader.searcher();
        let top_docs = searcher.search(&combined, &TopDocs::with_limit(limit))?;
        top_docs
            .into_iter()
            .map(|(_, address)| {
                let doc = searcher.doc::<TantivyDocument>(address)?;
                self.document_from_tantivy(doc)
            })
            .collect()
    }

    fn document_from_tantivy(
        &self,
        doc: TantivyDocument,
    ) -> Result<ProductSearchDocument, ProductSearchError> {
        let value: serde_json::Value = serde_json::from_str(&doc.to_json(&self.inner.schema))?;
        let get_text = |field: &str| -> Result<String, ProductSearchError> {
            value
                .get(field)
                .and_then(|entries| entries.as_array())
                .and_then(|entries| entries.first())
                .and_then(|entry| entry.as_str())
                .map(str::to_owned)
                .ok_or(ProductSearchError::StoredDocumentMissingField)
        };
        let materials = get_text("materials")?
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let intended_use_text = get_text("intended_use")?;
        let intended_use = if intended_use_text.trim().is_empty() {
            None
        } else {
            Some(intended_use_text)
        };
        Ok(ProductSearchDocument {
            tenant_id: Uuid::parse_str(&get_text("tenant_id")?)?,
            product_id: Uuid::parse_str(&get_text("product_id")?)?,
            sku: get_text("sku")?,
            name: get_text("name")?,
            description: get_text("description")?,
            materials,
            intended_use,
        })
    }
}

impl Default for ProductSearchIndex {
    fn default() -> Self {
        Self::in_memory().expect("in-memory Tantivy product search index should initialize")
    }
}

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

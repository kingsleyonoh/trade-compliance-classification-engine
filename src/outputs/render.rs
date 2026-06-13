use serde_json::Value;

use super::ExportFormat;
use crate::errors::ApiError;

pub(super) fn render_snapshot(snapshot: Value, format: ExportFormat) -> Result<String, ApiError> {
    match format {
        ExportFormat::Json => render_json(&snapshot),
        ExportFormat::Csv => Ok(csv_from_snapshot(&snapshot)),
        ExportFormat::Pdf => Ok(pdf_html_from_snapshot(&snapshot)),
    }
}

fn render_json(snapshot: &Value) -> Result<String, ApiError> {
    serde_json::to_string_pretty(snapshot).map_err(|_| {
        ApiError::service_unavailable(
            "audit_render_failed",
            "audit snapshot could not be rendered",
        )
    })
}

fn csv_from_snapshot(snapshot: &Value) -> String {
    let fields = [
        snapshot["tenant"]["display_name"].as_str().unwrap_or(""),
        snapshot["product"]["description"].as_str().unwrap_or(""),
        snapshot["classification"]["selected_code"]
            .as_str()
            .unwrap_or(""),
        snapshot["classification"]["risk_band"]
            .as_str()
            .unwrap_or(""),
    ];
    format!(
        "tenant,product,selected_code,risk_band\n{}\n",
        fields.map(csv_escape).join(",")
    )
}

fn pdf_html_from_snapshot(snapshot: &Value) -> String {
    let tenant = html_escape(snapshot["tenant"]["display_name"].as_str().unwrap_or(""));
    let product = html_escape(snapshot["product"]["description"].as_str().unwrap_or(""));
    let selected_code = html_escape(
        snapshot["classification"]["selected_code"]
            .as_str()
            .unwrap_or(""),
    );
    let risk_band = html_escape(
        snapshot["classification"]["risk_band"]
            .as_str()
            .unwrap_or(""),
    );
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Audit Pack</title></head><body><article data-export-format=\"pdf\"><h1>Audit Pack</h1><dl><dt>Tenant</dt><dd>{tenant}</dd><dt>Product</dt><dd>{product}</dd><dt>Selected code</dt><dd>{selected_code}</dd><dt>Risk band</dt><dd>{risk_band}</dd></dl><p>Rendered from a frozen AuditSnapshot.</p></article></body></html>"
    )
}

fn csv_escape(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

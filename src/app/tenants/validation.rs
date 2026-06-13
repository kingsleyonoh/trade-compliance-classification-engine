use serde_json::Value;
use uuid::Uuid;

use super::RegisterTenantRequest;
use crate::errors::ApiError;

pub(super) fn validate_registration(payload: &RegisterTenantRequest) -> Result<(), ApiError> {
    validate_required_names(payload)?;
    require_non_empty_object(&payload.address, "missing_address", "address is required")?;
    require_non_empty_object(
        &payload.registration,
        "missing_registration",
        "registration is required",
    )?;
    require_non_empty_object(&payload.contact, "missing_contact", "contact is required")?;
    validate_wordmark_and_regulators(payload)?;
    validate_matching_contact_email(payload)
}

pub(super) fn registration_rate_limit_key(admin_email: &str) -> String {
    format!("admin_email:{}", admin_email.trim().to_ascii_lowercase())
}

pub(super) fn slugify(display_name: &str, tenant_id: Uuid) -> String {
    let slug = display_name
        .chars()
        .filter_map(slug_char)
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let base = if slug.is_empty() {
        "tenant".to_string()
    } else {
        slug
    };
    format!("{}-{}", base, &tenant_id.to_string()[..8])
}

fn validate_required_names(payload: &RegisterTenantRequest) -> Result<(), ApiError> {
    for (value, code, message) in [
        (
            &payload.legal_name,
            "missing_legal_name",
            "legal_name is required",
        ),
        (
            &payload.full_legal_name,
            "missing_full_legal_name",
            "full_legal_name is required",
        ),
        (
            &payload.display_name,
            "missing_display_name",
            "display_name is required",
        ),
    ] {
        if value.trim().is_empty() {
            return Err(ApiError::bad_request(code, message));
        }
    }
    Ok(())
}

fn validate_wordmark_and_regulators(payload: &RegisterTenantRequest) -> Result<(), ApiError> {
    if payload.wordmark.trim().is_empty() {
        return Err(ApiError::bad_request(
            "missing_wordmark",
            "wordmark is required",
        ));
    }
    if !payload.regulator_ids.is_object() {
        return Err(ApiError::bad_request(
            "invalid_regulator_ids",
            "regulator_ids must be an object",
        ));
    }
    Ok(())
}

fn validate_matching_contact_email(payload: &RegisterTenantRequest) -> Result<(), ApiError> {
    let admin_email = normalize_email(&payload.admin_email)?;
    let contact_email = payload
        .contact
        .get("email")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ApiError::bad_request("missing_contact_email", "contact.email is required")
        })?;
    if normalize_email(contact_email)? != admin_email {
        return Err(ApiError::bad_request(
            "invalid_contact_email",
            "contact.email must match admin_email",
        ));
    }
    Ok(())
}

fn require_non_empty_object(
    value: &Value,
    code: &'static str,
    message: &'static str,
) -> Result<(), ApiError> {
    match value.as_object() {
        Some(object) if !object.is_empty() => Ok(()),
        _ => Err(ApiError::bad_request(code, message)),
    }
}

fn normalize_email(email: &str) -> Result<String, ApiError> {
    let trimmed = email.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request(
            "missing_admin_email",
            "admin_email is required",
        ));
    }
    if !trimmed.contains('@') {
        return Err(ApiError::bad_request(
            "invalid_admin_email",
            "admin_email must be an email address",
        ));
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn slug_char(ch: char) -> Option<char> {
    if ch.is_ascii_alphanumeric() {
        Some(ch.to_ascii_lowercase())
    } else if ch.is_whitespace() || ch == '-' || ch == '_' {
        Some('-')
    } else {
        None
    }
}

CREATE TABLE IF NOT EXISTS reviewer_overrides (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    classification_run_id uuid NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
    reviewer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    previous_code text,
    override_code text NOT NULL,
    reason_code text NOT NULL CHECK (reason_code IN ('missing_material','wrong_use_case','rule_conflict','supplier_evidence','legal_guidance','other')),
    note text,
    structured_correction jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reviewer_overrides_run_idx
    ON reviewer_overrides(tenant_id, classification_run_id, created_at, id);
CREATE INDEX IF NOT EXISTS reviewer_overrides_reviewer_idx
    ON reviewer_overrides(tenant_id, reviewer_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_exports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    classification_run_id uuid NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('queued','rendering','ready','failed')),
    format text NOT NULL CHECK (format IN ('json','pdf','csv')),
    payload_snapshot jsonb NOT NULL,
    file_path text,
    failure_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_exports_status_idx
    ON audit_exports(tenant_id, status);
CREATE INDEX IF NOT EXISTS audit_exports_run_idx
    ON audit_exports(tenant_id, classification_run_id);
CREATE INDEX IF NOT EXISTS audit_exports_created_idx
    ON audit_exports(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('rag_platform','notification_hub','workflow_engine')),
    enabled boolean NOT NULL DEFAULT false,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    secret_ref text,
    last_checked_at timestamptz,
    last_status text CHECK (last_status IN ('unknown','healthy','degraded','failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_settings_tenant_provider_unique
    ON integration_settings(tenant_id, provider);
CREATE INDEX IF NOT EXISTS integration_settings_enabled_idx
    ON integration_settings(tenant_id, enabled);

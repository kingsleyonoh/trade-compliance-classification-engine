CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE TYPE user_scope AS ENUM ('admin', 'classifier', 'reviewer', 'auditor'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE product_readiness_status AS ENUM ('ready', 'needs_review'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE rule_pack_status AS ENUM ('draft', 'active', 'archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE classification_job_status AS ENUM ('queued', 'leased', 'completed', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tenants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE,
    legal_name text NOT NULL, full_legal_name text NOT NULL, display_name text NOT NULL,
    address jsonb NOT NULL DEFAULT '{}'::jsonb, registration jsonb NOT NULL DEFAULT '{}'::jsonb,
    contact jsonb NOT NULL DEFAULT '{}'::jsonb, wordmark text NOT NULL,
    regulator_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email text NOT NULL, scope user_scope NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS api_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, key_hash text NOT NULL UNIQUE,
    key_prefix text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz
);

CREATE TABLE IF NOT EXISTS products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sku text NOT NULL, name text NOT NULL, description text NOT NULL, country_of_origin text NOT NULL,
    jurisdiction text NOT NULL, product_type text, materials jsonb NOT NULL DEFAULT '[]'::jsonb, intended_use text,
    readiness_status product_readiness_status NOT NULL DEFAULT 'needs_review', source_row jsonb NOT NULL DEFAULT '{}'::jsonb,
    archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS rule_packs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name text NOT NULL, version text NOT NULL, status rule_pack_status NOT NULL DEFAULT 'draft',
    payload jsonb NOT NULL DEFAULT '{}'::jsonb, validation_report jsonb NOT NULL DEFAULT '{}'::jsonb,
    activated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, name, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS rule_packs_one_active_per_name ON rule_packs(tenant_id, name) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS classification_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT, rule_pack_id uuid REFERENCES rule_packs(id) ON DELETE RESTRICT,
    product_snapshot jsonb NOT NULL, rule_pack_version text, candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
    selected_code text, confidence numeric(5,4), risk_band text, explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS classification_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE, status classification_job_status NOT NULL DEFAULT 'queued',
    attempts integer NOT NULL DEFAULT 0, leased_until timestamptz, last_error text, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_tenant_idx ON users(tenant_id);
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS products_tenant_created_idx ON products(tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS products_tenant_readiness_idx ON products(tenant_id, readiness_status);
CREATE INDEX IF NOT EXISTS classification_runs_tenant_product_idx ON classification_runs(tenant_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS classification_jobs_tenant_status_idx ON classification_jobs(tenant_id, status, created_at);

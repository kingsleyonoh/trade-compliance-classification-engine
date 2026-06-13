ALTER TABLE tenants ADD COLUMN IF NOT EXISTS default_jurisdiction text NOT NULL DEFAULT 'US';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

ALTER TABLE products ADD COLUMN IF NOT EXISTS external_ref text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE products ADD COLUMN IF NOT EXISTS search_document text NOT NULL DEFAULT '';

ALTER TABLE rule_packs ADD COLUMN IF NOT EXISTS jurisdiction text NOT NULL DEFAULT 'US';
ALTER TABLE rule_packs ADD COLUMN IF NOT EXISTS source_yaml text NOT NULL DEFAULT '';
ALTER TABLE rule_packs ADD COLUMN IF NOT EXISTS source_hash text NOT NULL DEFAULT '';

ALTER TABLE classification_runs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE classification_runs ADD COLUMN IF NOT EXISTS input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE classification_runs ADD COLUMN IF NOT EXISTS candidate_codes jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE classification_jobs ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE classification_jobs ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE classification_jobs ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;

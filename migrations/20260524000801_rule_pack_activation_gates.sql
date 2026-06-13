ALTER TYPE rule_pack_status ADD VALUE IF NOT EXISTS 'validating';
ALTER TYPE rule_pack_status ADD VALUE IF NOT EXISTS 'retired';
ALTER TYPE rule_pack_status ADD VALUE IF NOT EXISTS 'failed';

ALTER TABLE rule_packs ADD COLUMN IF NOT EXISTS compiled_wasm_sha256 text;
ALTER TABLE rule_packs ADD COLUMN IF NOT EXISTS golden_case_count integer NOT NULL DEFAULT 0;
ALTER TABLE rule_packs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP INDEX IF EXISTS rule_packs_one_active_per_name;
WITH ranked_active_rule_packs AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY tenant_id, jurisdiction
               ORDER BY activated_at DESC NULLS LAST, created_at DESC, id DESC
           ) AS active_rank
    FROM rule_packs
    WHERE status = 'active'
)
UPDATE rule_packs rp
SET status = 'archived'
FROM ranked_active_rule_packs ranked
WHERE rp.id = ranked.id AND ranked.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS rule_packs_one_active_per_jurisdiction
    ON rule_packs(tenant_id, jurisdiction)
    WHERE status = 'active';

CREATE OR REPLACE FUNCTION prevent_active_rule_pack_mutation()
RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'active' AND (
        NEW.name IS DISTINCT FROM OLD.name OR
        NEW.version IS DISTINCT FROM OLD.version OR
        NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction OR
        NEW.source_yaml IS DISTINCT FROM OLD.source_yaml OR
        NEW.source_hash IS DISTINCT FROM OLD.source_hash OR
        NEW.compiled_wasm_sha256 IS DISTINCT FROM OLD.compiled_wasm_sha256 OR
        NEW.golden_case_count IS DISTINCT FROM OLD.golden_case_count OR
        NEW.payload IS DISTINCT FROM OLD.payload OR
        NEW.validation_report IS DISTINCT FROM OLD.validation_report OR
        NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    ) THEN
        RAISE EXCEPTION 'active rule packs are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

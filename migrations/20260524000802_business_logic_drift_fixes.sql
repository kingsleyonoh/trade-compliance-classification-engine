ALTER TABLE classification_runs ADD COLUMN IF NOT EXISTS jurisdiction text NOT NULL DEFAULT 'US';
ALTER TABLE classification_runs ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE classification_runs ADD COLUMN IF NOT EXISTS finished_at timestamptz;
ALTER TABLE classification_runs ADD COLUMN IF NOT EXISTS failure_reason text;
ALTER TABLE classification_runs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE classification_jobs ADD COLUMN IF NOT EXISTS classification_run_id uuid REFERENCES classification_runs(id) ON DELETE CASCADE;

DO $$
DECLARE
    job record;
    generated_run_id uuid;
    snapshot jsonb;
BEGIN
    FOR job IN
        SELECT j.id AS job_id,
               j.tenant_id,
               j.product_id,
               j.payload,
               p.sku,
               p.name,
               p.description,
               p.country_of_origin,
               p.jurisdiction,
               p.product_type,
               p.materials,
               p.intended_use,
               p.source_row,
               rp.id AS rule_pack_id,
               rp.version AS rule_pack_version
        FROM classification_jobs j
        JOIN products p ON p.tenant_id = j.tenant_id AND p.id = j.product_id
        LEFT JOIN LATERAL (
            SELECT id, version
            FROM rule_packs
            WHERE tenant_id = j.tenant_id AND jurisdiction = p.jurisdiction AND status = 'active'
            ORDER BY activated_at DESC NULLS LAST, created_at DESC, id DESC
            LIMIT 1
        ) rp ON true
        WHERE j.classification_run_id IS NULL
    LOOP
        snapshot := COALESCE(
            job.payload->'input_snapshot',
            jsonb_build_object(
                'id', job.product_id,
                'sku', job.sku,
                'name', job.name,
                'description', job.description,
                'country_of_origin', job.country_of_origin,
                'jurisdiction', job.jurisdiction,
                'product_type', job.product_type,
                'materials', job.materials,
                'intended_use', job.intended_use,
                'source_row', job.source_row
            )
        );
        INSERT INTO classification_runs (
            tenant_id,
            product_id,
            rule_pack_id,
            jurisdiction,
            product_snapshot,
            input_snapshot,
            rule_pack_version,
            status
        ) VALUES (
            job.tenant_id,
            job.product_id,
            job.rule_pack_id,
            job.jurisdiction,
            snapshot,
            snapshot,
            job.rule_pack_version,
            'queued'
        ) RETURNING id INTO generated_run_id;
        UPDATE classification_jobs
        SET classification_run_id = generated_run_id,
            payload = job.payload || jsonb_build_object(
                'classification_run_id', generated_run_id,
                'product_id', job.product_id,
                'rule_pack_id', job.rule_pack_id,
                'jurisdiction', job.jurisdiction,
                'input_snapshot', snapshot
            )
        WHERE id = job.job_id;
    END LOOP;
END $$;

ALTER TABLE classification_jobs ALTER COLUMN classification_run_id SET NOT NULL;

WITH duplicate_rule_pack_versions AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY tenant_id, jurisdiction, version
               ORDER BY (status = 'active') DESC, activated_at DESC NULLS LAST, created_at DESC, id DESC
           ) AS duplicate_rank
    FROM rule_packs
)
UPDATE rule_packs rp
SET version = rp.version || '-dedup-' || left(rp.id::text, 8)
FROM duplicate_rule_pack_versions ranked
WHERE rp.id = ranked.id AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS rule_packs_tenant_jurisdiction_version_unique
    ON rule_packs(tenant_id, jurisdiction, version);

CREATE INDEX IF NOT EXISTS classification_jobs_run_idx
    ON classification_jobs(classification_run_id)
    WHERE classification_run_id IS NOT NULL;

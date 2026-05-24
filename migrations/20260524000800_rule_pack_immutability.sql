CREATE OR REPLACE FUNCTION prevent_active_rule_pack_mutation()
RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'active' AND (
        NEW.name IS DISTINCT FROM OLD.name OR
        NEW.version IS DISTINCT FROM OLD.version OR
        NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction OR
        NEW.source_yaml IS DISTINCT FROM OLD.source_yaml OR
        NEW.source_hash IS DISTINCT FROM OLD.source_hash OR
        NEW.payload IS DISTINCT FROM OLD.payload OR
        NEW.validation_report IS DISTINCT FROM OLD.validation_report OR
        NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    ) THEN
        RAISE EXCEPTION 'active rule packs are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rule_packs_prevent_active_mutation ON rule_packs;
CREATE TRIGGER rule_packs_prevent_active_mutation
BEFORE UPDATE ON rule_packs
FOR EACH ROW EXECUTE FUNCTION prevent_active_rule_pack_mutation();

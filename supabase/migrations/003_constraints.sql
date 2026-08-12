-- 003_constraints.sql - Fase 4B
-- Índices, unicidades e triggers de integridade.

-- ---------- índices de consulta ----------
CREATE INDEX IF NOT EXISTS idx_tx_profile_date   ON transactions (profile_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_tx_account        ON transactions (account_id);
CREATE INDEX IF NOT EXISTS idx_tx_category       ON transactions (category_id);
CREATE INDEX IF NOT EXISTS idx_tx_status         ON transactions (status);
CREATE INDEX IF NOT EXISTS idx_cat_parent        ON categories (parent_id);
CREATE INDEX IF NOT EXISTS idx_queue_status      ON reclassification_queue (status);
CREATE INDEX IF NOT EXISTS idx_queue_tx          ON reclassification_queue (transaction_id);
CREATE INDEX IF NOT EXISTS idx_audit_tx          ON category_assignment_audit (transaction_id);
CREATE INDEX IF NOT EXISTS idx_audit_queue       ON category_assignment_audit (queue_item_id);

-- ---------- fila: um único item aberto por (transação, reason) ----------
CREATE UNIQUE INDEX IF NOT EXISTS uq_queue_open_reason
    ON reclassification_queue (transaction_id, reason)
    WHERE status = 'open';

-- ---------- trigger: sem sobreposição de períodos conta-perfil ----------
CREATE OR REPLACE FUNCTION app_check_no_overlap_periods() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    overlap integer;
BEGIN
    SELECT count(*) INTO overlap
      FROM account_profile_periods p
     WHERE p.account_id = NEW.account_id
       AND p.id <> NEW.id
       AND daterange(p.starts_on, coalesce(p.ends_on, 'infinity'::date), '[]')
           && daterange(NEW.starts_on, coalesce(NEW.ends_on, 'infinity'::date), '[]');
    IF overlap > 0 THEN
        RAISE EXCEPTION 'sobreposicao de periodos para a conta %', NEW.account_id
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_no_overlap_periods ON account_profile_periods;
CREATE TRIGGER trg_no_overlap_periods
    BEFORE INSERT OR UPDATE ON account_profile_periods
    FOR EACH ROW EXECUTE FUNCTION app_check_no_overlap_periods();

-- ---------- trigger: anti-ciclo na árvore de categorias ----------
CREATE OR REPLACE FUNCTION app_check_category_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    ancestor uuid;
BEGIN
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;
    -- NEW não pode ser ancestral de si mesmo (caminho parent_id até raiz)
    ancestor := NEW.parent_id;
    WHILE ancestor IS NOT NULL LOOP
        IF ancestor = NEW.id THEN
            RAISE EXCEPTION 'ciclo na arvore de categorias: %', NEW.id
                USING ERRCODE = 'P0001';
        END IF;
        SELECT parent_id INTO ancestor FROM categories WHERE id = ancestor;
    END LOOP;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_category_cycle ON categories;
CREATE TRIGGER trg_category_cycle
    BEFORE INSERT OR UPDATE OF parent_id, id ON categories
    FOR EACH ROW EXECUTE FUNCTION app_check_category_cycle();

-- ---------- trigger: updated_at ----------
CREATE OR REPLACE FUNCTION app_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['profiles','accounts','account_profile_periods','categories',
                            'category_aliases','account_aliases','transactions','auth_users'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_%I ON %I', t, t);
        EXECUTE format('CREATE TRIGGER trg_touch_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()', t, t);
    END LOOP;
END;
$$;

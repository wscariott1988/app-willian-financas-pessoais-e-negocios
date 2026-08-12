-- ============================================================================
-- SETUP_SUPABASE_CLOUD.sql
-- Setup unico para um projeto Supabase Cloud VAZIO.
-- Consolidacao EXATA, em ordem, das migrations 001..007 do projeto.
-- Nenhum usuario, senha ou dado seed e incluido (seed fica em SEED_DEMO.sql).
-- Instrucao: abra o SQL Editor do projeto, cole o arquivo inteiro e execute
-- UMA unica vez. Depois crie os usuarios no Authentication e rode SEED_DEMO.sql.
-- ============================================================================


-- ============================================================================
-- MIGRATION 001_baseline.sql
-- Roles de API (estilo Supabase/PostgREST) e controle de migrations.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS app;

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
);


-- ============================================================================
-- MIGRATION 002_schema.sql
-- Schema canonico v1.1 (documento mestre) + extensoes aprovadas na Fase 4B
-- (reclassification_queue, category_assignment_audit, auth_users, status scheduled).
-- ============================================================================

-- ---------- profiles ----------
CREATE TABLE profiles (
    id           uuid PRIMARY KEY,
    code         text NOT NULL UNIQUE CHECK (code IN ('personal', 'business')),
    display_name text NOT NULL,
    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------- accounts ----------
CREATE TABLE accounts (
    id              uuid PRIMARY KEY,
    source_name     text NOT NULL,
    display_name    text NOT NULL,
    normalized_name text NOT NULL UNIQUE,
    account_type    text NOT NULL CHECK (account_type IN ('bank', 'credit_card', 'cash', 'benefit', 'investment', 'other')),
    is_active       boolean NOT NULL DEFAULT true,
    archived_at     timestamptz,
    is_favorite     boolean NOT NULL DEFAULT false,
    usage_score     numeric(6, 3) NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- account_profile_periods ----------
CREATE TABLE account_profile_periods (
    id         uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts (id),
    profile_id uuid NOT NULL REFERENCES profiles (id),
    starts_on  date NOT NULL,
    ends_on    date CHECK (ends_on IS NULL OR ends_on >= starts_on),
    source     text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, profile_id, starts_on)
);

-- ---------- categories (arvore recursiva) ----------
CREATE TABLE categories (
    id              uuid PRIMARY KEY,
    profile_id      uuid NOT NULL REFERENCES profiles (id),
    direction       text NOT NULL CHECK (direction IN ('income', 'expense', 'transfer')),
    parent_id       uuid REFERENCES categories (id),
    source_name     text NOT NULL,
    display_name    text NOT NULL,
    normalized_name text NOT NULL,
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'review')),
    canonical_path  text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (profile_id, direction, parent_id, normalized_name)
);

-- ---------- aliases ----------
CREATE TABLE category_aliases (
    id                uuid PRIMARY KEY,
    profile_id        uuid REFERENCES profiles (id),
    direction         text CHECK (direction IN ('income', 'expense', 'transfer')),
    raw_pattern       text NOT NULL,
    normalized_pattern text NOT NULL,
    match_kind        text NOT NULL CHECK (match_kind IN ('exact', 'regex')),
    target_id         uuid NOT NULL REFERENCES categories (id),
    priority          integer NOT NULL DEFAULT 100,
    is_active         boolean NOT NULL DEFAULT true,
    requires_review   boolean NOT NULL DEFAULT false,
    source_evidence   text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (profile_id, normalized_pattern, target_id)
);

CREATE TABLE account_aliases (
    id                uuid PRIMARY KEY,
    profile_id        uuid REFERENCES profiles (id),
    direction         text CHECK (direction IN ('income', 'expense', 'transfer')),
    raw_pattern       text NOT NULL,
    normalized_pattern text NOT NULL,
    match_kind        text NOT NULL CHECK (match_kind IN ('exact', 'regex')),
    target_id         uuid NOT NULL REFERENCES accounts (id),
    priority          integer NOT NULL DEFAULT 100,
    is_active         boolean NOT NULL DEFAULT true,
    requires_review   boolean NOT NULL DEFAULT false,
    source_evidence   text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (profile_id, normalized_pattern, target_id)
);

-- ---------- import_batches ----------
CREATE TABLE import_batches (
    id          uuid PRIMARY KEY,
    source_name text NOT NULL,
    checksum    text,
    status      text NOT NULL DEFAULT 'completed',
    counts      jsonb,
    imported_at timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- transactions ----------
CREATE TABLE transactions (
    id                     uuid PRIMARY KEY,
    profile_id             uuid NOT NULL REFERENCES profiles (id),
    account_id             uuid NOT NULL REFERENCES accounts (id),
    category_id            uuid REFERENCES categories (id),
    transaction_kind       text NOT NULL CHECK (transaction_kind IN ('income', 'expense', 'transfer')),
    amount                 numeric(18, 2) NOT NULL CHECK (amount > 0),
    occurred_on            date NOT NULL,
    posted_on              date,
    raw_description        text NOT NULL,
    normalized_description text NOT NULL,
    memo                   text,
    import_batch_id        uuid REFERENCES import_batches (id),
    external_record_id     text,
    status                 text NOT NULL DEFAULT 'posted'
                           CHECK (status IN ('posted', 'pending', 'review', 'scheduled', 'ignored')),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    UNIQUE (import_batch_id, external_record_id)
);

-- ---------- transfer_links ----------
CREATE TABLE transfer_links (
    id                 uuid PRIMARY KEY,
    out_transaction_id uuid NOT NULL UNIQUE REFERENCES transactions (id),
    in_transaction_id  uuid NOT NULL UNIQUE REFERENCES transactions (id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (out_transaction_id <> in_transaction_id)
);

-- ---------- category_merge_map ----------
CREATE TABLE category_merge_map (
    id                    uuid PRIMARY KEY,
    old_category_id       uuid NOT NULL REFERENCES categories (id),
    canonical_category_id uuid NOT NULL REFERENCES categories (id),
    reason                text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (old_category_id, canonical_category_id)
);

-- ---------- migration_decisions ----------
CREATE TABLE migration_decisions (
    id            uuid PRIMARY KEY,
    topic         text NOT NULL UNIQUE,
    status        text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'pending', 'rejected')),
    decision      text NOT NULL,
    evidence      text,
    effective_from date,
    decided_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- reclassification_queue ----------
CREATE TABLE reclassification_queue (
    id              uuid PRIMARY KEY,
    transaction_id  uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    reason          text NOT NULL,
    proposed_target uuid REFERENCES categories (id),
    status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
    review_note     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    closed_at       timestamptz
);

-- ---------- category_assignment_audit (Fase 4B) ----------
CREATE TABLE category_assignment_audit (
    id              uuid PRIMARY KEY,
    transaction_id  uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    queue_item_id   uuid REFERENCES reclassification_queue (id),
    from_category_id uuid REFERENCES categories (id),
    to_category_id  uuid NOT NULL REFERENCES categories (id),
    assigned_by     uuid,
    reason          text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- auth_users (equivalente local a auth.users do GoTrue) ----------
CREATE TABLE auth_users (
    id            uuid PRIMARY KEY,
    email         text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    profile_id    uuid NOT NULL REFERENCES profiles (id),
    display_name  text,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);


-- ============================================================================
-- MIGRATION 003_constraints.sql
-- Indices, unicidades e triggers de integridade.
-- ============================================================================

-- ---------- indices de consulta ----------
CREATE INDEX IF NOT EXISTS idx_tx_profile_date   ON transactions (profile_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_tx_account        ON transactions (account_id);
CREATE INDEX IF NOT EXISTS idx_tx_category       ON transactions (category_id);
CREATE INDEX IF NOT EXISTS idx_tx_status         ON transactions (status);
CREATE INDEX IF NOT EXISTS idx_cat_parent        ON categories (parent_id);
CREATE INDEX IF NOT EXISTS idx_queue_status      ON reclassification_queue (status);
CREATE INDEX IF NOT EXISTS idx_queue_tx          ON reclassification_queue (transaction_id);
CREATE INDEX IF NOT EXISTS idx_audit_tx          ON category_assignment_audit (transaction_id);
CREATE INDEX IF NOT EXISTS idx_audit_queue       ON category_assignment_audit (queue_item_id);

-- ---------- fila: um unico item aberto por (transacao, reason) ----------
CREATE UNIQUE INDEX IF NOT EXISTS uq_queue_open_reason
    ON reclassification_queue (transaction_id, reason)
    WHERE status = 'open';

-- ---------- trigger: sem sobreposicao de periodos conta-perfil ----------
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

-- ---------- trigger: anti-ciclo na arvore de categorias ----------
CREATE OR REPLACE FUNCTION app_check_category_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    ancestor uuid;
BEGIN
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;
    -- NEW nao pode ser ancestral de si mesmo (caminho parent_id ate raiz)
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


-- ============================================================================
-- MIGRATION 004_rls.sql
-- Politicas RLS por perfil. O gateway de API executa:
--   SET LOCAL request.jwt.claims = '{"role": ..., "sub": ..., "profile_id": ...}'
--   SET LOCAL ROLE anon|authenticated
-- e cada politica decide com base nos claims (estilo PostgREST/Supabase).
-- ============================================================================

CREATE OR REPLACE FUNCTION app.jwt_role() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
$$;

CREATE OR REPLACE FUNCTION app.jwt_profile_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'profile_id', '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.jwt_sub() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

-- perfis: leitura apenas do proprio perfil; escrita somente service_role
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select_own ON profiles FOR SELECT
    USING (app.jwt_role() = 'service_role' OR id = app.jwt_profile_id());
CREATE POLICY profiles_write_service ON profiles FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- contas: catalogo global de leitura para autenticados; escrita service_role
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_select_auth ON accounts FOR SELECT
    USING (app.jwt_role() IN ('service_role', 'authenticated'));
CREATE POLICY accounts_write_service ON accounts FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- periodos conta-perfil: leitura autenticada; escrita service_role
ALTER TABLE account_profile_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY periods_select_auth ON account_profile_periods FOR SELECT
    USING (app.jwt_role() IN ('service_role', 'authenticated'));
CREATE POLICY periods_write_service ON account_profile_periods FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- categorias: catalogo global de leitura; escrita service_role
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY categories_select_auth ON categories FOR SELECT
    USING (app.jwt_role() IN ('service_role', 'authenticated'));
CREATE POLICY categories_write_service ON categories FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- aliases: leitura autenticada; escrita service_role
ALTER TABLE category_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY aliases_cat_select ON category_aliases FOR SELECT
    USING (app.jwt_role() IN ('service_role', 'authenticated'));
CREATE POLICY aliases_cat_write ON category_aliases FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

ALTER TABLE account_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY aliases_acct_select ON account_aliases FOR SELECT
    USING (app.jwt_role() IN ('service_role', 'authenticated'));
CREATE POLICY aliases_acct_write ON account_aliases FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- transactions: leitura restrita ao perfil do token; escrita service_role
-- (atribuicao de categoria passa pela funcao atomica 005)
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY transactions_select_own ON transactions FOR SELECT
    USING (app.jwt_role() = 'service_role' OR profile_id = app.jwt_profile_id());
CREATE POLICY transactions_write_service ON transactions FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- fila: leitura restrita ao perfil da transacao; fechamento via funcao atomica
ALTER TABLE reclassification_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY queue_select_own ON reclassification_queue FOR SELECT
    USING (app.jwt_role() = 'service_role'
           OR EXISTS (SELECT 1 FROM transactions t
                      WHERE t.id = reclassification_queue.transaction_id
                        AND t.profile_id = app.jwt_profile_id()));
CREATE POLICY queue_write_service ON reclassification_queue FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- auditoria: leitura restrita ao perfil; escrita via funcao atomica
ALTER TABLE category_assignment_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_select_own ON category_assignment_audit FOR SELECT
    USING (app.jwt_role() = 'service_role'
           OR EXISTS (SELECT 1 FROM transactions t
                      WHERE t.id = category_assignment_audit.transaction_id
                        AND t.profile_id = app.jwt_profile_id()));
CREATE POLICY audit_write_service ON category_assignment_audit FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- infraestrutura: somente service_role
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY batches_all_service ON import_batches FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

ALTER TABLE migration_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY decisions_select_auth ON migration_decisions FOR SELECT
    USING (app.jwt_role() IN ('service_role', 'authenticated'));
CREATE POLICY decisions_write_service ON migration_decisions FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

ALTER TABLE transfer_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY links_write_service ON transfer_links FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

ALTER TABLE category_merge_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY merges_select_auth ON category_merge_map FOR SELECT
    USING (app.jwt_role() IN ('service_role', 'authenticated'));
CREATE POLICY merges_write_service ON category_merge_map FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

ALTER TABLE auth_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_users_select_self ON auth_users FOR SELECT
    USING (app.jwt_role() = 'service_role' OR id = app.jwt_sub());
CREATE POLICY auth_users_write_service ON auth_users FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- ---------- grants (privilegios reais + RLS) ----------
GRANT USAGE ON SCHEMA public, app TO anon, authenticated;
GRANT SELECT ON profiles, accounts, account_profile_periods, categories,
    category_aliases, account_aliases, transactions, reclassification_queue,
    category_assignment_audit, migration_decisions, category_merge_map, auth_users
    TO authenticated;
GRANT SELECT ON profiles, accounts, account_profile_periods, categories,
    category_aliases, account_aliases, transactions, reclassification_queue,
    category_assignment_audit, migration_decisions, category_merge_map, auth_users
    TO anon;
GRANT EXECUTE ON FUNCTION app.jwt_role(), app.jwt_profile_id(), app.jwt_sub() TO anon, authenticated;


-- ============================================================================
-- MIGRATION 005_functions.sql
-- Funcao atomica de atribuicao de categoria (fluxo vertical):
--   1) valida propriedade (perfil do token = perfil da transacao);
--   2) valida categoria compativel (perfil + direcao + ativa);
--   3) atualiza transactions (categoria + transaction_kind);
--   4) fecha o item CORRETO da fila (mesma transacao, aberto, prioridade documentada);
--   5) insere category_assignment_audit;
--   tudo em uma transacao: qualquer violacao faz rollback completo.
-- ============================================================================

CREATE OR REPLACE FUNCTION app.assign_category_atomic(
    p_transaction_id uuid,
    p_category_id    uuid,
    p_profile_id     uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_tx_profile   uuid;
    v_tx_kind      text;
    v_old_category uuid;
    v_cat_profile  uuid;
    v_cat_direction text;
    v_cat_status   text;
    v_closed_queue uuid;
    v_audit_id     uuid;
BEGIN
    -- ownership: o perfil do token precisa ser dono da transacao
    SELECT profile_id, transaction_kind, category_id
      INTO v_tx_profile, v_tx_kind, v_old_category
      FROM transactions WHERE id = p_transaction_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'transacao % nao encontrada', p_transaction_id;
    END IF;
    IF v_tx_profile <> p_profile_id THEN
        RAISE EXCEPTION 'perfil do token nao possui a transacao %', p_transaction_id;
    END IF;

    -- categoria: perfil + ativa
    SELECT profile_id, direction, status
      INTO v_cat_profile, v_cat_direction, v_cat_status
      FROM categories WHERE id = p_category_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'categoria % nao encontrada', p_category_id;
    END IF;
    IF v_cat_profile <> p_profile_id THEN
        RAISE EXCEPTION 'categoria % pertence a outro perfil', p_category_id;
    END IF;
    IF v_cat_status <> 'active' THEN
        RAISE EXCEPTION 'categoria % nao esta ativa', p_category_id;
    END IF;

    -- direcao compativel (transferencias nao recebem categoria de receita/despesa)
    IF v_tx_kind = 'transfer' THEN
        RAISE EXCEPTION 'transacao de transferencia nao recebe categoria';
    END IF;
    IF v_cat_direction <> v_tx_kind THEN
        RAISE EXCEPTION 'categoria de direcao % incompativel com transacao % (kind %)',
            v_cat_direction, p_transaction_id, v_tx_kind;
    END IF;

    -- 3) atualiza a transacao
    UPDATE transactions
       SET category_id = p_category_id,
           transaction_kind = v_cat_direction,
           updated_at = now()
     WHERE id = p_transaction_id;

    -- 4) fecha o item correto da fila:
    --    prioridade documentada: sem_categoria > sem_correspondencia > motivos de revisao (RP-*)
    UPDATE reclassification_queue
       SET status = 'closed', closed_at = now()
     WHERE id = (
           SELECT id FROM reclassification_queue
            WHERE transaction_id = p_transaction_id AND status = 'open'
            ORDER BY CASE reason
                       WHEN 'sem_categoria' THEN 1
                       WHEN 'sem_correspondencia' THEN 2
                       ELSE 3
                     END,
                     created_at
            LIMIT 1
           FOR UPDATE SKIP LOCKED
     )
     RETURNING id INTO v_closed_queue;

    -- 5) auditoria
    INSERT INTO category_assignment_audit
        (id, transaction_id, queue_item_id, from_category_id, to_category_id,
         assigned_by, reason, created_at)
    VALUES
        (gen_random_uuid(), p_transaction_id, v_closed_queue, v_old_category,
         p_category_id, p_profile_id, 'assign_category_atomic', now())
    RETURNING id INTO v_audit_id;

    RETURN jsonb_build_object(
        'transaction_id', p_transaction_id,
        'category_id', p_category_id,
        'from_category_id', v_old_category,
        'queue_item_id', v_closed_queue,
        'audit_id', v_audit_id
    );
END;
$$;

GRANT EXECUTE ON FUNCTION app.assign_category_atomic(uuid, uuid, uuid) TO authenticated;


-- ============================================================================
-- MIGRATION 006_category_raw.sql
-- Exposicao do texto original de categoria para auditoria/UI (o schema v1.1
-- mapeia categoria por category_id; category_raw preserva o rotulo da fonte).
-- ============================================================================

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_raw text;

CREATE INDEX IF NOT EXISTS idx_tx_category_raw ON transactions (category_raw);


-- ============================================================================
-- MIGRATION 007_cloud_compat.sql
-- Compatibilidade Supabase Cloud (APLICAR NO SQL EDITOR DO PROJETO CLOUD)
-- Adapta o schema ao PostgREST/Auth do Supabase Cloud:
--   1) app.jwt_profile_id() passa a ler profile_id de app_metadata (o JWT do GoTrue
--      coloca raw_app_meta_data dentro de app_metadata — o claim nao fica no nivel
--      raiz do JWT);
--   2) trigger handle_new_user: ao criar um usuario em auth.users, garante o profile
--      na tabela profiles (por code) e grava profile_id/profile_code em
--      raw_app_meta_data;
--   3) overload de assign_category_atomic com 2 argumentos, derivando o profile do
--      JWT (o gateway local injetava o 3o argumento; no Cloud quem injeta e o claim);
--   4) grants de escrita para authenticated nas tabelas usadas pelo app.
-- ============================================================================

-- ---------- 1) jwt_profile_id compativel com o JWT do Supabase Cloud ----------
CREATE OR REPLACE FUNCTION app.jwt_profile_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT nullif(
      coalesce(
        current_setting('request.jwt.claims', true)::jsonb #>> '{app_metadata, profile_id}',
        current_setting('request.jwt.claims', true)::jsonb ->> 'profile_id'
      ), ''
    )::uuid;
$$;

-- ---------- 2) trigger de novo usuario (auth.users -> profiles + app_metadata) ----------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code       text;
  v_profile_id uuid;
  v_display    text;
BEGIN
  v_code := coalesce(new.raw_user_meta_data ->> 'profile_code', 'personal');
  IF v_code NOT IN ('personal', 'business') THEN v_code := 'personal'; END IF;
  -- Fallback por email: emails de demonstracao com "negocio/business" viram perfil business
  IF (new.raw_user_meta_data ->> 'profile_code') IS NULL
     AND (new.email ILIKE '%negocio%' OR new.email ILIKE '%business%') THEN
    v_code := 'business';
  END IF;
  v_display := CASE WHEN v_code = 'business' THEN 'Negocio' ELSE 'Pessoal' END;

  SELECT id INTO v_profile_id FROM profiles WHERE code = v_code LIMIT 1;
  IF v_profile_id IS NULL THEN
    v_profile_id := gen_random_uuid();
    INSERT INTO profiles (id, code, display_name, is_active)
    VALUES (v_profile_id, v_code, v_display, TRUE);
  END IF;

  UPDATE auth.users
     SET raw_app_meta_data =
         coalesce(raw_app_meta_data, '{}'::jsonb)
         || jsonb_build_object('profile_id', v_profile_id::text, 'profile_code', v_code)
   WHERE id = new.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------- 3) RPC com 2 argumentos (profile derivado do JWT) ----------
CREATE OR REPLACE FUNCTION app.assign_category_atomic(p_transaction_id uuid, p_category_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS $$
    SELECT app.assign_category_atomic(p_transaction_id, p_category_id, app.jwt_profile_id());
$$;

GRANT EXECUTE ON FUNCTION app.assign_category_atomic(uuid, uuid) TO authenticated;

-- Wrapper em public: o PostgREST do Supabase Cloud expoe somente o schema public,
-- e supabase.rpc('assign_category_atomic', ...) resolve a funcao nesse schema.
CREATE OR REPLACE FUNCTION public.assign_category_atomic(p_transaction_id uuid, p_category_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
  v_profile_id uuid;
BEGIN
  v_profile_id := app.jwt_profile_id();
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'perfil do token nao encontrado: crie o usuario apos o trigger handle_new_user (007)';
  END IF;
  RETURN app.assign_category_atomic(p_transaction_id, p_category_id, v_profile_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_category_atomic(uuid, uuid) TO authenticated;

-- ---------- 4) grants de escrita para o app (as politicas RLS de escrita seguem
--              service_role-only; o app escreve transacoes/categorias via RPC
--              SECURITY DEFINER) ----------
GRANT INSERT, UPDATE, DELETE ON transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON reclassification_queue TO authenticated;
GRANT SELECT, INSERT ON category_assignment_audit TO authenticated;
GRANT USAGE ON SCHEMA app TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO authenticated;

-- 004_rls.sql - Fase 4B
-- Políticas RLS por perfil. O gateway de API executa:
--   SET LOCAL request.jwt.claims = '{"role": ..., "sub": ..., "profile_id": ...}'
--   SET LOCAL ROLE anon|authenticated
-- e cada política decide com base nos claims (estilo PostgREST/Supabase).

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

-- perfis: leitura apenas do próprio perfil; escrita somente service_role
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select_own ON profiles FOR SELECT
    USING (app.jwt_role() = 'service_role' OR id = app.jwt_profile_id());
CREATE POLICY profiles_write_service ON profiles FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- contas: catálogo global de leitura para autenticados; escrita service_role
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_select_auth ON accounts FOR SELECT
    USING (app.jwt_role() IN ('service_role', 'authenticated'));
CREATE POLICY accounts_write_service ON accounts FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- períodos conta-perfil: leitura autenticada; escrita service_role
ALTER TABLE account_profile_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY periods_select_auth ON account_profile_periods FOR SELECT
    USING (app.jwt_role() IN ('service_role', 'authenticated'));
CREATE POLICY periods_write_service ON account_profile_periods FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- categorias: catálogo global de leitura; escrita service_role
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
-- (atribuição de categoria passa pela função atômica 005)
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY transactions_select_own ON transactions FOR SELECT
    USING (app.jwt_role() = 'service_role' OR profile_id = app.jwt_profile_id());
CREATE POLICY transactions_write_service ON transactions FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- fila: leitura restrita ao perfil da transação; fechamento via função atômica
ALTER TABLE reclassification_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY queue_select_own ON reclassification_queue FOR SELECT
    USING (app.jwt_role() = 'service_role'
           OR EXISTS (SELECT 1 FROM transactions t
                      WHERE t.id = reclassification_queue.transaction_id
                        AND t.profile_id = app.jwt_profile_id()));
CREATE POLICY queue_write_service ON reclassification_queue FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

-- auditoria: leitura restrita ao perfil; escrita via função atômica
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

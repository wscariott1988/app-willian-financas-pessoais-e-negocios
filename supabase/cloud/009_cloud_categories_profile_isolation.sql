-- ============================================================
-- 009_cloud_categories_profile_isolation.sql  (Cloud 009 <- local 008)
-- Isolamento de categorias por perfil no Supabase Cloud.
-- Estado vivo esperado (confirmado pelo verificador): policy ampla
-- categories_select_auth presente; categories_select_own ausente.
-- Se o estado divergir, o script ABORTA antes de qualquer escrita.
-- NUNCA oferece rollback para a policy ampla (decisão permanente).
-- Transacional: qualquer falha desfaz tudo.
-- ============================================================

BEGIN;

-- ---------- Pré-validação do estado vivo ----------
DO $$
DECLARE
    v_ampla   integer;
    v_isolada integer;
BEGIN
    SELECT count(*) INTO v_ampla   FROM pg_policies
     WHERE schemaname='public' AND tablename='categories'
       AND policyname='categories_select_auth';
    SELECT count(*) INTO v_isolada FROM pg_policies
     WHERE schemaname='public' AND tablename='categories'
       AND policyname='categories_select_own';

    IF v_ampla <> 1 THEN
        RAISE EXCEPTION 'CLOUD009: policy ampla categories_select_auth ausente ou duplicada (esperado exatamente 1)';
    END IF;
    IF v_isolada <> 0 THEN
        RAISE EXCEPTION 'CLOUD009: policy isolada categories_select_own ja existe (replicacao detectada)';
    END IF;
END $$;

-- ---------- Aplicação ----------
DROP POLICY categories_select_auth ON categories;

CREATE POLICY categories_select_own ON categories FOR SELECT
    USING (
        app.jwt_role() = 'service_role'
        OR categories.profile_id = app.jwt_profile_id()
    );

-- ---------- Pós-validação ----------
DO $$
DECLARE
    v_ampla   integer;
    v_isolada integer;
BEGIN
    SELECT count(*) INTO v_ampla   FROM pg_policies
     WHERE schemaname='public' AND tablename='categories'
       AND policyname='categories_select_auth';
    SELECT count(*) INTO v_isolada FROM pg_policies
     WHERE schemaname='public' AND tablename='categories'
       AND policyname='categories_select_own';
    IF v_ampla <> 0 THEN
        RAISE EXCEPTION 'CLOUD009: policy ampla ainda presente apos a aplicacao';
    END IF;
    IF v_isolada <> 1 THEN
        RAISE EXCEPTION 'CLOUD009: policy isolada nao criada';
    END IF;
END $$;

COMMIT;

-- ============================================================
-- 016_cloud_account_profile_periods_by_profile.sql
-- Adaptação Cloud do ACC-P0 (aprovado localmente).
--
-- Regra aprovada:
--   * mesma conta + mesmo perfil + períodos sobrepostos = PROIBIDO;
--   * mesma conta + perfis diferentes + períodos simultâneos = PERMITIDO.
--
-- Duas mudanças funcionais:
--   1) Trigger public.app_check_no_overlap_periods(): a detecção de overlap
--      passa a considerar profile_id (account_id + profile_id);
--   2) Backfill determinístico: para cada par (account_id, profile_id) usado
--      fisicamente por transactions (inclusive soft-deleted) e SEM associação
--      em account_profile_periods, insere 1 período:
--        starts_on = MIN(transactions.occurred_on), ends_on = NULL.
--      IDs determinísticos (md5 built-in, sem extensão) para permitir
--      identificação exata no rollback.
--
-- Atômico (BEGIN/COMMIT); não desabilita trigger/constraint/RLS; sem CASCADE.
-- Não altera transactions, categories, category_raw nem períodos existentes.
-- ============================================================

BEGIN;

-- ---------- Pré-validação estrutural ----------
DO $$
BEGIN
    IF to_regclass('public.account_profile_periods') IS NULL THEN
        RAISE EXCEPTION 'CLOUD016: public.account_profile_periods ausente';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                    WHERE n.nspname='public' AND p.proname='app_check_no_overlap_periods') THEN
        RAISE EXCEPTION 'CLOUD016: public.app_check_no_overlap_periods ausente';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.account_profile_periods'::regclass
                    AND tgname='trg_no_overlap_periods' AND NOT tgisinternal) THEN
        RAISE EXCEPTION 'CLOUD016: trg_no_overlap_periods ausente';
    END IF;
END $$;

-- ---------- 1) Trigger: sobreposição por (account_id, profile_id) ----------
CREATE OR REPLACE FUNCTION public.app_check_no_overlap_periods() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    overlap integer;
BEGIN
    SELECT count(*) INTO overlap
      FROM public.account_profile_periods p
     WHERE p.account_id = NEW.account_id
       AND p.profile_id = NEW.profile_id
       AND p.id <> NEW.id
       AND daterange(p.starts_on, coalesce(p.ends_on, 'infinity'::date), '[]')
           && daterange(NEW.starts_on, coalesce(NEW.ends_on, 'infinity'::date), '[]');
    IF overlap > 0 THEN
        RAISE EXCEPTION 'sobreposicao de periodos para a conta % no perfil %', NEW.account_id, NEW.profile_id
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

-- ---------- 2) Backfill determinístico (idempotente via NOT EXISTS) ----------
INSERT INTO public.account_profile_periods (id, account_id, profile_id, starts_on, ends_on, source, created_at, updated_at)
SELECT md5(t.account_id::text || ':' || t.profile_id::text)::uuid,
       t.account_id, t.profile_id, min(t.occurred_on), NULL, 'backfill_016', now(), now()
  FROM public.transactions t
 WHERE NOT EXISTS (
       SELECT 1 FROM public.account_profile_periods pp
        WHERE pp.account_id = t.account_id
          AND pp.profile_id = t.profile_id
 )
 GROUP BY t.account_id, t.profile_id;

-- ---------- 3) Detecção de inconsistência (reporta, NÃO corrige) ----------
DO $$
DECLARE
    v_uncovered bigint;
BEGIN
    SELECT count(*) INTO v_uncovered
      FROM public.transactions t
     WHERE NOT EXISTS (
           SELECT 1 FROM public.account_profile_periods pp
            WHERE pp.account_id = t.account_id
              AND pp.profile_id = t.profile_id
              AND pp.starts_on <= t.occurred_on
              AND (pp.ends_on IS NULL OR pp.ends_on >= t.occurred_on)
     );
    RAISE NOTICE 'CLOUD016: transacoes sem periodo valido = % (nao corrigido automaticamente)', v_uncovered;
END $$;

COMMIT;
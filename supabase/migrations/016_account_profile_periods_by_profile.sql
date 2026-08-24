-- ============================================================
-- 016_account_profile_periods_by_profile.sql
-- Correção do modelo de account_profile_periods (ACC-P0):
--   * a MESMA conta pode ter períodos simultâneos em PERFIS DIFERENTES;
--   * continua PROIBIDO sobrepor períodos dentro do MESMO perfil;
--   * associações ausentes são reconstruídas deterministicamente a partir
--     das transações existentes (nenhuma transação é alterada).
--
-- Regra aprovada:
--   sobreposição proibida = mesmo account_id + mesmo profile_id
--   sobreposição entre profiles diferentes = permitida
--
-- 1) Trigger: a condição de overlap passa a incluir profile_id.
--    Antes (003): p.account_id = NEW.account_id (qualquer perfil).
--    Depois     : p.account_id = NEW.account_id AND p.profile_id = NEW.profile_id.
-- 2) Backfill determinístico e idempotente (NOT EXISTS): para cada par
--    (account_id, profile_id) com transações históricas e SEM associação,
--    insere starts_on = MIN(transactions.occurred_on), ends_on = NULL.
--    Inclui transações soft-deleted (histórico físico). Sem corte por nome,
--    sem heurística, sem data inventada.
-- 3) Não altera períodos existentes, não fecha/transfere nada, não toca
--    transações. Inconsistências (período existente que não cobre alguma
--    transação) são DETECTADAS e reportadas via NOTICE — não corrigidas.
-- ============================================================

BEGIN;

-- 1) Trigger de sobreposição por (account_id, profile_id)
CREATE OR REPLACE FUNCTION app_check_no_overlap_periods() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    overlap integer;
BEGIN
    SELECT count(*) INTO overlap
      FROM account_profile_periods p
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

-- 2) Backfill determinístico (idempotente; transações físicas, inclusive soft-deleted)
INSERT INTO account_profile_periods (id, account_id, profile_id, starts_on, ends_on, source, created_at, updated_at)
SELECT gen_random_uuid(), t.account_id, t.profile_id, min(t.occurred_on), NULL, 'backfill_016', now(), now()
  FROM transactions t
 WHERE NOT EXISTS (
       SELECT 1 FROM account_profile_periods pp
        WHERE pp.account_id = t.account_id
          AND pp.profile_id = t.profile_id
 )
 GROUP BY t.account_id, t.profile_id;

-- 3) Detecção de inconsistência (reporta, NÃO corrige):
--    transações sem período válido (mesma regra de cobertura do assert_account_for_profile)
DO $$
DECLARE
    v_uncovered bigint;
BEGIN
    SELECT count(*) INTO v_uncovered
      FROM transactions t
     WHERE NOT EXISTS (
           SELECT 1 FROM account_profile_periods pp
            WHERE pp.account_id = t.account_id
              AND pp.profile_id = t.profile_id
              AND pp.starts_on <= t.occurred_on
              AND (pp.ends_on IS NULL OR pp.ends_on >= t.occurred_on)
     );
    RAISE NOTICE '016: transacoes sem periodo valido = % (nao corrigido automaticamente)', v_uncovered;
END $$;

COMMIT;
-- ============================================================
-- ROLLBACK_CLOUD_016_ACCOUNT_PERIODS.sql
-- Reverte 016_cloud_account_profile_periods_by_profile.sql.
--
-- 1) ESTRUTURAL (obrigatório): restaura a função de overlap ANTERIOR
--    (sobreposição por account_id independentemente de profile_id).
--    O trigger trg_no_overlap_periods permanece ligado à função (o
--    CREATE OR REPLACE troca apenas o corpo).
--
-- 2) DADOS — conservador e DETERMINÍSTICO:
--    O 016 inseriu as linhas do backfill com:
--      * source = 'backfill_016';
--      * id = md5(account_id::text || ':' || profile_id::text)::uuid
--        (ID determinístico, md5 nativo do PostgreSQL, sem extensão).
--    Portanto o rollback apaga EXATAMENTE essas linhas, identificadas por
--    source + id determinístico. Períodos legítimos criados depois (outros
--    ids/sources) NÃO são apagados.
--    Não há DELETE por aproximação; não há CASCADE; não desabilita trigger.
-- ============================================================

BEGIN;

-- 1) Restaurar função ANTERIOR (overlap por account_id, sem profile_id)
CREATE OR REPLACE FUNCTION public.app_check_no_overlap_periods() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    overlap integer;
BEGIN
    SELECT count(*) INTO overlap
      FROM public.account_profile_periods p
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

-- 2) Remover EXATAMENTE as linhas criadas pelo backfill 016
--    (identificação determinística: source + id md5 derivado do par).
DELETE FROM public.account_profile_periods pp
 WHERE pp.source = 'backfill_016'
   AND pp.id = md5(pp.account_id::text || ':' || pp.profile_id::text)::uuid;

COMMIT;

-- Recarregar schema PostgREST
SELECT pg_notify('pgrst', 'reload schema');
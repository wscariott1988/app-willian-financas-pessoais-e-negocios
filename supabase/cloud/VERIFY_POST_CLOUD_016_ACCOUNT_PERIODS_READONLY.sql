-- READ-ONLY: este arquivo não contém DDL, DML ou chamadas de RPC.
-- ============================================================
-- VERIFY_POST_CLOUD_016_ACCOUNT_PERIODS_READONLY.sql
-- Verificação PÓS-aplicação do 016 Cloud (períodos por perfil).
-- Uma única statement SELECT -> uma grade exportável.
-- Sem dados financeiros individuais; sem credenciais.
-- ============================================================

SELECT * FROM (

-- 1) Função de overlap contém semanticamente account_id + profile_id
SELECT 1 AS ord, 'stg_016_funcao_com_perfil' AS stage,
       CASE WHEN (SELECT position('profile_id' in lower(pg_get_functiondef(p.oid))) > 0
                    AND position('account_id' in lower(pg_get_functiondef(p.oid))) > 0
                   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='public' AND p.proname='app_check_no_overlap_periods')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'funcao_atual', (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                             WHERE n.nspname='public' AND p.proname='app_check_no_overlap_periods')
       ) AS detail

UNION ALL

-- 2) Trigger continua presente
SELECT 2 AS ord, 'stg_016_trigger_presente' AS stage,
       CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.account_profile_periods'::regclass
                          AND tgname='trg_no_overlap_periods' AND NOT tgisinternal)
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object('trg', (SELECT tgname FROM pg_trigger WHERE tgrelid='public.account_profile_periods'::regclass
                                   AND tgname='trg_no_overlap_periods' AND NOT tgisinternal)) AS detail

UNION ALL

-- 3) Pares usados sem qualquer associação = 0
SELECT 3 AS ord, 'stg_016_pares_sem_assoc_zero' AS stage,
       CASE WHEN (SELECT count(DISTINCT (t.account_id, t.profile_id)) FROM public.transactions t
                   WHERE NOT EXISTS (SELECT 1 FROM public.account_profile_periods pp
                                      WHERE pp.account_id = t.account_id AND pp.profile_id = t.profile_id)) = 0
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'pares_sem_assoc', (SELECT count(DISTINCT (t.account_id, t.profile_id))::int FROM public.transactions t
                                WHERE NOT EXISTS (SELECT 1 FROM public.account_profile_periods pp
                                                   WHERE pp.account_id = t.account_id AND pp.profile_id = t.profile_id))
       ) AS detail

UNION ALL

-- 4) Cobertura temporal: transações sem período válido = 0
SELECT 4 AS ord, 'stg_016_cobertura_zero' AS stage,
       CASE WHEN (SELECT count(*) FROM public.transactions t
                   WHERE NOT EXISTS (SELECT 1 FROM public.account_profile_periods pp
                                      WHERE pp.account_id = t.account_id
                                        AND pp.profile_id = t.profile_id
                                        AND pp.starts_on <= t.occurred_on
                                        AND (pp.ends_on IS NULL OR pp.ends_on >= t.occurred_on))) = 0
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'uncovered', (SELECT count(*)::int FROM public.transactions t
                          WHERE NOT EXISTS (SELECT 1 FROM public.account_profile_periods pp
                                             WHERE pp.account_id = t.account_id
                                               AND pp.profile_id = t.profile_id
                                               AND pp.starts_on <= t.occurred_on
                                               AND (pp.ends_on IS NULL OR pp.ends_on >= t.occurred_on)))
       ) AS detail

UNION ALL

-- 5) Overlaps dentro de (account_id, profile_id) = 0
SELECT 5 AS ord, 'stg_016_overlap_zero' AS stage,
       CASE WHEN (SELECT count(*) FROM public.account_profile_periods p
                   WHERE EXISTS (SELECT 1 FROM public.account_profile_periods q
                                  WHERE q.account_id = p.account_id
                                    AND q.profile_id = p.profile_id
                                    AND q.id <> p.id
                                    AND daterange(q.starts_on, coalesce(q.ends_on,'infinity'::date),'[]')
                                        && daterange(p.starts_on, coalesce(p.ends_on,'infinity'::date),'[]'))) = 0
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'overlaps', (SELECT count(*)::int FROM public.account_profile_periods p
                         WHERE EXISTS (SELECT 1 FROM public.account_profile_periods q
                                        WHERE q.account_id = p.account_id
                                          AND q.profile_id = p.profile_id
                                          AND q.id <> p.id
                                          AND daterange(q.starts_on, coalesce(q.ends_on,'infinity'::date),'[]')
                                              && daterange(p.starts_on, coalesce(p.ends_on,'infinity'::date),'[]')))
       ) AS detail

UNION ALL

-- 6) assert_account_for_profile continua exigindo conta+perfil+período
SELECT 6 AS ord, 'stg_016_assert_preservado' AS stage,
       CASE WHEN to_regprocedure('app.assert_account_for_profile(uuid,uuid,date)') IS NOT NULL
             AND (SELECT position('account_profile_periods' in lower(pg_get_functiondef(p.oid))) > 0
                   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='app' AND p.proname='assert_account_for_profile')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'assert', to_regprocedure('app.assert_account_for_profile(uuid,uuid,date)'),
           'usa_account_profile_periods', (SELECT position('account_profile_periods' in lower(pg_get_functiondef(p.oid))) > 0
                                            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                                            WHERE n.nspname='app' AND p.proname='assert_account_for_profile')
       ) AS detail

UNION ALL

-- 7) Constraints/FKs preservadas
SELECT 7 AS ord, 'stg_016_fks_preservadas' AS stage,
       CASE WHEN EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
                          WHERE rel.oid='public.account_profile_periods'::regclass AND c.contype='f' AND c.conname LIKE '%account_id%')
             AND EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
                          WHERE rel.oid='public.account_profile_periods'::regclass AND c.contype='f' AND c.conname LIKE '%profile_id%')
             AND EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
                          WHERE rel.oid='public.account_profile_periods'::regclass AND c.contype='u')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'fks', (SELECT string_agg(conname, ',') FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
                    WHERE rel.oid='public.account_profile_periods'::regclass AND c.contype='f'),
           'uniques', (SELECT string_agg(conname, ',') FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
                        WHERE rel.oid='public.account_profile_periods'::regclass AND c.contype='u')
       ) AS detail

UNION ALL

-- 8) Fingerprints para comparação pré/pós (read-only, sem gravar)
SELECT 8 AS ord, 'stg_016_fingerprints' AS stage,
       'INFO' AS status,
       jsonb_build_object(
           'n_tx_fisico', (SELECT count(*)::int FROM public.transactions),
           'n_tx_ativo', (SELECT count(*)::int FROM public.transactions WHERE deleted_at IS NULL),
           'n_periods', (SELECT count(*)::int FROM public.account_profile_periods),
           'n_backfill', (SELECT count(*)::int FROM public.account_profile_periods WHERE source = 'backfill_016'),
           'tx_hash', (SELECT md5(string_agg(t.id::text||'|'||t.account_id::text||'|'||t.profile_id::text, ',' ORDER BY t.id))
                        FROM public.transactions t),
           'cat_id_hash', (SELECT md5(string_agg(t.id::text||'|'||coalesce(t.category_id::text,''), ',' ORDER BY t.id))
                            FROM public.transactions t),
           'cat_raw_hash', (SELECT md5(string_agg(t.id::text||'|'||coalesce(t.category_raw::text,''), ',' ORDER BY t.id))
                             FROM public.transactions t)
       ) AS detail

) s
ORDER BY ord;
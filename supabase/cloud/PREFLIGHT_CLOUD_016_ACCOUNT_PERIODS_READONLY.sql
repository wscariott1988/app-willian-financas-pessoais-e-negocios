-- READ-ONLY: este arquivo não contém DDL, DML ou chamadas de RPC.
-- ============================================================
-- PREFLIGHT_CLOUD_016_ACCOUNT_PERIODS_READONLY.sql
-- Pré-condições para 016_cloud_account_profile_periods_by_profile.sql.
-- Uma única statement SELECT -> uma grade exportável.
-- Sem dados financeiros individuais; sem credenciais.
-- ============================================================

SELECT * FROM (

-- A1) Estrutura: account_profile_periods existe
SELECT 1 AS ord, 'stg_016_estrutura_tabela' AS stage,
       CASE WHEN to_regclass('public.account_profile_periods') IS NOT NULL THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object('account_profile_periods', to_regclass('public.account_profile_periods')) AS detail

UNION ALL

-- A2) Estrutura: colunas necessárias
SELECT 2 AS ord, 'stg_016_estrutura_colunas' AS stage,
       CASE WHEN (SELECT count(*) FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='account_profile_periods'
                     AND column_name IN ('id','account_id','profile_id','starts_on','ends_on','source')) = 6
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object('colunas', (SELECT string_agg(column_name, ',') FROM information_schema.columns
                                       WHERE table_schema='public' AND table_name='account_profile_periods')) AS detail

UNION ALL

-- A3) Estrutura: tabelas base (transactions, profiles, accounts)
SELECT 3 AS ord, 'stg_016_tabelas_base' AS stage,
       CASE WHEN to_regclass('public.transactions') IS NOT NULL
             AND to_regclass('public.profiles') IS NOT NULL
             AND to_regclass('public.accounts') IS NOT NULL
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'transactions', to_regclass('public.transactions'),
           'profiles', to_regclass('public.profiles'),
           'accounts', to_regclass('public.accounts')
       ) AS detail

UNION ALL

-- A4) Estrutura: app_check_no_overlap_periods existe
SELECT 4 AS ord, 'stg_016_funcao_overlap_existe' AS stage,
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                          WHERE n.nspname='public' AND p.proname='app_check_no_overlap_periods')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object('existe', EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                                             WHERE n.nspname='public' AND p.proname='app_check_no_overlap_periods')) AS detail

UNION ALL

-- A5) Estrutura: trigger trg_no_overlap_periods existe
SELECT 5 AS ord, 'stg_016_trigger_existe' AS stage,
       CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.account_profile_periods'::regclass
                          AND tgname='trg_no_overlap_periods' AND NOT tgisinternal)
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object('trg', (SELECT tgname FROM pg_trigger WHERE tgrelid='public.account_profile_periods'::regclass
                                   AND tgname='trg_no_overlap_periods' AND NOT tgisinternal)) AS detail

UNION ALL

-- A6) Estrutura: app.assert_account_for_profile(uuid,uuid,date) existe
SELECT 6 AS ord, 'stg_016_assert_conta_existe' AS stage,
       CASE WHEN to_regprocedure('app.assert_account_for_profile(uuid,uuid,date)') IS NOT NULL
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object('assert_account_for_profile', to_regprocedure('app.assert_account_for_profile(uuid,uuid,date)')) AS detail

UNION ALL

-- B) Estado da função atual: pré-016 = overlap por account_id SEM profile_id
SELECT 7 AS ord, 'stg_016_funcao_estado_pre' AS stage,
       CASE WHEN (SELECT position('profile_id' in lower(pg_get_functiondef(p.oid))) = 0
                    AND position('account_id' in lower(pg_get_functiondef(p.oid))) > 0
                   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='public' AND p.proname='app_check_no_overlap_periods')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'funcao_atual', (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                             WHERE n.nspname='public' AND p.proname='app_check_no_overlap_periods')
       ) AS detail

UNION ALL

-- C) Integridade existente (contagens derivadas do estado atual)
SELECT 8 AS ord, 'stg_016_integridade_counts' AS stage,
       'INFO' AS status,
       jsonb_build_object(
           'n_tx_fisico', (SELECT count(*)::int FROM public.transactions),
           'n_tx_ativo', (SELECT count(*)::int FROM public.transactions WHERE deleted_at IS NULL),
           'n_periods', (SELECT count(*)::int FROM public.account_profile_periods),
           'pares_usados', (SELECT count(DISTINCT (account_id, profile_id))::int FROM public.transactions),
           'pares_sem_assoc', (SELECT count(DISTINCT (t.account_id, t.profile_id))::int FROM public.transactions t
                                WHERE NOT EXISTS (SELECT 1 FROM public.account_profile_periods pp
                                                   WHERE pp.account_id = t.account_id AND pp.profile_id = t.profile_id)),
           'uncovered', (SELECT count(*)::int FROM public.transactions t
                          WHERE NOT EXISTS (SELECT 1 FROM public.account_profile_periods pp
                                             WHERE pp.account_id = t.account_id AND pp.profile_id = t.profile_id
                                               AND pp.starts_on <= t.occurred_on
                                               AND (pp.ends_on IS NULL OR pp.ends_on >= t.occurred_on)))
       ) AS detail

UNION ALL

-- D) Inconsistência que o backfill NÃO pode corrigir: par com período mas com
--    transações fora de todos os seus períodos -> BLOCKED
SELECT 9 AS ord, 'stg_016_inconsistencia_nao_corrigivel' AS stage,
       CASE WHEN (SELECT count(*) FROM (
                    SELECT DISTINCT t.account_id, t.profile_id
                      FROM public.transactions t
                     WHERE EXISTS (SELECT 1 FROM public.account_profile_periods pp
                                    WHERE pp.account_id = t.account_id AND pp.profile_id = t.profile_id)
                       AND NOT EXISTS (SELECT 1 FROM public.account_profile_periods pp
                                        WHERE pp.account_id = t.account_id AND pp.profile_id = t.profile_id
                                          AND pp.starts_on <= t.occurred_on
                                          AND (pp.ends_on IS NULL OR pp.ends_on >= t.occurred_on))
                  ) x) = 0
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'pares_com_periodo_e_tx_fora', (SELECT count(*)::int FROM (
                                             SELECT DISTINCT t.account_id, t.profile_id
                                               FROM public.transactions t
                                              WHERE EXISTS (SELECT 1 FROM public.account_profile_periods pp
                                                             WHERE pp.account_id = t.account_id AND pp.profile_id = t.profile_id)
                                                AND NOT EXISTS (SELECT 1 FROM public.account_profile_periods pp
                                                                 WHERE pp.account_id = t.account_id AND pp.profile_id = t.profile_id
                                                                   AND pp.starts_on <= t.occurred_on
                                                                   AND (pp.ends_on IS NULL OR pp.ends_on >= t.occurred_on))
                                           ) x)
       ) AS detail

UNION ALL

-- E) Overlap existente dentro do mesmo (account_id, profile_id) -> BLOCKED
SELECT 10 AS ord, 'stg_016_overlap_existente' AS stage,
       CASE WHEN (SELECT count(*) FROM public.account_profile_periods p
                   WHERE EXISTS (SELECT 1 FROM public.account_profile_periods q
                                  WHERE q.account_id = p.account_id
                                    AND q.profile_id = p.profile_id
                                    AND q.id <> p.id
                                    AND daterange(q.starts_on, coalesce(q.ends_on,'infinity'::date),'[]')
                                        && daterange(p.starts_on, coalesce(p.ends_on,'infinity'::date),'[]'))) = 0
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'overlaps_mesmo_perfil', (SELECT count(*)::int FROM public.account_profile_periods p
                                      WHERE EXISTS (SELECT 1 FROM public.account_profile_periods q
                                                     WHERE q.account_id = p.account_id
                                                       AND q.profile_id = p.profile_id
                                                       AND q.id <> p.id
                                                       AND daterange(q.starts_on, coalesce(q.ends_on,'infinity'::date),'[]')
                                                           && daterange(p.starts_on, coalesce(p.ends_on,'infinity'::date),'[]')))
       ) AS detail

UNION ALL

-- F) schema_migrations: 016 ainda NÃO registrado
SELECT 11 AS ord, 'stg_016_schema_migrations' AS stage,
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.schema_migrations
                              WHERE version = '016_cloud_account_profile_periods_by_profile.sql')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'registrado', EXISTS (SELECT 1 FROM public.schema_migrations
                                  WHERE version = '016_cloud_account_profile_periods_by_profile.sql')
       ) AS detail

UNION ALL

-- Fingerprints para comparação pré/pós (read-only, sem gravar)
SELECT 12 AS ord, 'stg_016_fingerprints' AS stage,
       'INFO' AS status,
       jsonb_build_object(
           'n_tx_fisico', (SELECT count(*)::int FROM public.transactions),
           'n_tx_ativo', (SELECT count(*)::int FROM public.transactions WHERE deleted_at IS NULL),
           'tx_hash', (SELECT md5(string_agg(t.id::text||'|'||t.account_id::text||'|'||t.profile_id::text, ',' ORDER BY t.id))
                        FROM public.transactions t),
           'cat_id_hash', (SELECT md5(string_agg(t.id::text||'|'||coalesce(t.category_id::text,''), ',' ORDER BY t.id))
                            FROM public.transactions t),
           'cat_raw_hash', (SELECT md5(string_agg(t.id::text||'|'||coalesce(t.category_raw::text,''), ',' ORDER BY t.id))
                             FROM public.transactions t)
       ) AS detail

) s
ORDER BY ord;
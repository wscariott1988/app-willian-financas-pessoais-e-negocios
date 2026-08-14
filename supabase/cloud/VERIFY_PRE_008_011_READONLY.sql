-- READ-ONLY: este arquivo não contém DDL, DML ou chamadas de RPC.
-- ============================================================
-- VERIFY_PRE_008_011_READONLY.sql
-- Verificação viva do Supabase Cloud ANTES da aplicação de 008-011.
-- Executar manualmente no SQL Editor do projeto (https://aheq***ntxq.supabase.co).
-- Conteúdo 100% SELECT: não altera tabelas, policies, grants, funções ou dados.
-- Não consulta auth.users nem expõe emails, tokens ou hashes.
-- ============================================================

-- 1) Identificação segura do projeto (sem chaves ou segredos)
SELECT current_database() AS database_name,
       current_user       AS connection_role,
       current_setting('server_version') AS server_version;

-- 2) Migrations registradas e checksums (tabela do SETUP_SUPABASE_CLOUD)
SELECT version, checksum, applied_at
  FROM schema_migrations
 WHERE to_regclass('public.schema_migrations') IS NOT NULL
 ORDER BY version;

SELECT count(*) AS n_migrations_registradas
  FROM schema_migrations
 WHERE to_regclass('public.schema_migrations') IS NOT NULL;

-- 3a) RLS habilitada nas tabelas alvo (e se é forçada)
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('categories', 'transactions', 'transfer_links',
                     'reclassification_queue', 'category_assignment_audit',
                     'transaction_audit')
 ORDER BY 1;

-- 3b) Policies existentes nessas tabelas (comando, papéis, expressões USING/CHECK)
SELECT tablename, policyname, cmd, roles, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('categories', 'transactions', 'transfer_links',
                     'reclassification_queue', 'category_assignment_audit',
                     'transaction_audit')
 ORDER BY 1, 2;

-- 4a) Grants diretos de tabela por papel de API
SELECT table_name, grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name IN ('categories', 'transactions', 'transfer_links',
                      'reclassification_queue', 'category_assignment_audit',
                      'transaction_audit')
   AND grantee IN ('authenticated', 'anon', 'service_role')
 ORDER BY 1, 2, 3;

-- 4b) Grants diretos de EXECUTE em funções relevantes por papel de API
SELECT routine_schema, routine_name, grantee, privilege_type
  FROM information_schema.role_routine_grants
 WHERE routine_schema IN ('public', 'app')
   AND grantee IN ('authenticated', 'anon', 'service_role')
   AND routine_name IN ('assign_category_atomic', 'transaction_create',
                        'transaction_update', 'transaction_get_detail',
                        'normalize_description', 'tx_state_jsonb',
                        'assert_account_for_profile', 'resolve_category_for_profile',
                        'close_queue_item', 'close_all_open_queue')
 ORDER BY 1, 2, 3;

-- 4c) USAGE de schema por papel de API (privilégios de schema ficam em pg_namespace.nspacl;
--      information_schema não expõe USAGE de schema — por isso a leitura via pg_catalog.
--      nspacl nulo (schema sem ACL explícita) retorna zero linhas, sem erro.)
SELECT n.nspname AS schema_name,
       r.rolname  AS grantee,
       acl.privilege_type AS privilege_type
  FROM pg_namespace n
  CROSS JOIN LATERAL aclexplode(n.nspacl) AS acl
  JOIN pg_roles r ON r.oid = acl.grantee
 WHERE n.nspname IN ('public', 'app')
   AND r.rolname IN ('anon', 'authenticated', 'service_role')
 ORDER BY 1, 2, 3;

-- 5) Funções da 011 e da camada cloud: existência, schema, assinatura, definer, search_path
SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS result_type,
       p.prosecdef AS definer,
       p.provolatile AS volatility,
       p.proconfig AS search_path_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.proname IN ('assign_category_atomic', 'transaction_create',
                     'transaction_update', 'transaction_get_detail',
                     'normalize_description', 'tx_state_jsonb',
                     'assert_account_for_profile', 'resolve_category_for_profile',
                     'close_queue_item', 'close_all_open_queue',
                     'jwt_profile_id', 'jwt_sub', 'jwt_role')
 ORDER BY 1, 2, 3;

-- 6) Schemas relevantes existentes
SELECT schema_name
  FROM information_schema.schemata
 WHERE schema_name IN ('public', 'app', 'auth')
 ORDER BY 1;

-- 7a) transaction_audit existe?
SELECT to_regclass('public.transaction_audit') AS transaction_audit_exists;

-- 7b) Estrutura (colunas) — vazio se a tabela não existir
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'transaction_audit'
 ORDER BY ordinal_position;

-- 7c) Constraints — vazio se a tabela não existir
SELECT conname, contype
  FROM pg_constraint
 WHERE conrelid = (SELECT c.oid
                     FROM pg_class c
                     JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = 'transaction_audit')
 ORDER BY 1;

-- 7d) Índices — vazio se a tabela não existir
SELECT i.relname AS index_name
  FROM pg_index ix
  JOIN pg_class c ON c.oid = ix.indrelid
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'transaction_audit'
 ORDER BY 1;

-- 8) Policy ampla antiga (004) existe?
SELECT policyname, cmd, qual
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'categories'
   AND policyname = 'categories_select_auth';

-- 9) Policy isolada (008) existe?
SELECT policyname, cmd, qual
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'categories'
   AND policyname = 'categories_select_own';

-- Resumo 8/9: existência de cada uma
SELECT (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'categories'
           AND policyname = 'categories_select_auth') AS ampla_categories_select_auth,
       (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'categories'
           AND policyname = 'categories_select_own') AS isolada_categories_select_own;

-- 10a) Migration 009 — presença das 3 transações Inter PJ (agregado; sem descrições/valores)
SELECT count(*) AS interpj_existentes,
       count(*) FILTER (WHERE t.profile_id = (SELECT id FROM profiles WHERE code = 'personal')) AS perfil_pessoal,
       count(*) FILTER (WHERE t.transaction_kind = 'expense') AS expense,
       count(*) FILTER (WHERE t.status = 'review') AS review
  FROM (VALUES ('15e6da49-7d1f-5ae4-a936-f099a148cf6d'),
               ('38886977-8e8e-5c32-b8e8-6f2ec67edea5'),
               ('d0b03c47-a82f-57a7-a368-2e123af90d93')) v(u)
  LEFT JOIN transactions t ON t.id = v.u::uuid;

-- 10b) Migration 009 — filas/auditorias/links dessas 3 (agregados)
SELECT (SELECT count(*) FROM (VALUES ('15e6da49-7d1f-5ae4-a936-f099a148cf6d'),
                                      ('38886977-8e8e-5c32-b8e8-6f2ec67edea5'),
                                      ('d0b03c47-a82f-57a7-a368-2e123af90d93')) x(u)
         JOIN reclassification_queue q ON q.transaction_id = x.u::uuid) AS filas_totais,
       (SELECT count(*) FROM (VALUES ('15e6da49-7d1f-5ae4-a936-f099a148cf6d'),
                                      ('38886977-8e8e-5c32-b8e8-6f2ec67edea5'),
                                      ('d0b03c47-a82f-57a7-a368-2e123af90d93')) x(u)
         JOIN category_assignment_audit a ON a.transaction_id = x.u::uuid) AS auditorias_totais,
       (SELECT count(*) FROM (VALUES ('15e6da49-7d1f-5ae4-a936-f099a148cf6d'),
                                      ('38886977-8e8e-5c32-b8e8-6f2ec67edea5'),
                                      ('d0b03c47-a82f-57a7-a368-2e123af90d93')) x(u)
         JOIN transfer_links l ON l.out_transaction_id = x.u::uuid
                              OR l.in_transaction_id  = x.u::uuid) AS links_totais;

-- 10c) Migration 009 — categorias envolvidas (estado por agregação)
SELECT count(*) FILTER (WHERE id = '1b1911d6-2c15-503a-95da-f859f33af83c') AS ads_existe,
       count(*) FILTER (WHERE id = '1b1911d6-2c15-503a-95da-f859f33af83c'
                          AND profile_id = (SELECT id FROM profiles WHERE code = 'business')
                          AND direction = 'expense' AND status = 'active') AS ads_business_expense_active,
       count(*) FILTER (WHERE id = '1b1911d6-2c15-503a-95da-f859f33af83c'
                          AND parent_id = '224f5e21-47fa-5323-9e06-0ffe170c626d') AS ads_filho_de_trafego,
       count(*) FILTER (WHERE id = '224f5e21-47fa-5323-9e06-0ffe170c626d') AS trafego_pago_existe,
       count(*) FILTER (WHERE id = '30000000-0000-4000-8000-000000000009') AS raiz_marketing_existe
  FROM categories;

-- 10d) Migration 009 — transações por categoria (contagens, sem valores)
SELECT c.id AS category_id,
       count(t.id) AS n_transacoes,
       count(t.id) FILTER (WHERE t.transaction_kind = 'expense') AS n_expense
  FROM categories c
  LEFT JOIN transactions t ON t.category_id = c.id
 WHERE c.id IN ('1b1911d6-2c15-503a-95da-f859f33af83c',
                '30000000-0000-4000-8000-000000000009')
 GROUP BY c.id
 ORDER BY c.id;

-- 11a) Migration 010 — presença dos 100 UUIDs e agregados (sem descrições/valores)
SELECT count(*) AS ids_listados,
       count(DISTINCT u) AS ids_distintos,
       count(t.id) AS existentes,
       count(t.id) FILTER (WHERE t.profile_id = (SELECT id FROM profiles WHERE code = 'personal')) AS perfil_pessoal,
       count(t.id) FILTER (WHERE t.transaction_kind = 'expense') AS expense,
       count(t.id) FILTER (WHERE t.status = 'posted') AS posted,
       count(t.id) FILTER (WHERE t.status = 'review') AS review,
       count(t.id) FILTER (WHERE t.status = 'scheduled') AS scheduled,
       sum(t.amount) AS soma_total
  FROM (VALUES ('200d4021-7608-584f-95f4-80818ffa3d79'),
               ('6fc23233-d72e-5a32-acce-9c879953bdc3'),
               ('77d51531-b70a-5cc7-91cb-5d9137f4d674'),
               ('f487c210-6b56-54e9-9cd6-81e25d4c55a8'),
               ('a8fc5c7f-c535-510d-b605-05a9a181eb88'),
               ('49a99caa-d40c-54cf-9f54-2d15d6add75a'),
               ('085d12fb-bee6-5af6-81cb-6352bf0da1d2'),
               ('8ea44fec-d8d0-528f-9f45-8f8e2817d374'),
               ('9e0e214f-9f57-50f5-8ec2-465c3590944f'),
               ('cbb35900-971c-51a9-9cbe-aec3d978342a'),
               ('3673e313-72ec-5d50-a0e5-5efeab548b83'),
               ('7e34dfbb-af2a-55a8-b7e4-7ebc48f8b249'),
               ('ab68d2db-b2c4-59d5-8899-47c556ebdbf9'),
               ('9eecfb5c-eafa-5724-acc7-fd5f694b75e5'),
               ('f2548e41-90b3-5d43-b568-9ac384b35a67'),
               ('efefeefe-7c71-58c5-8eb1-7bcf8a69e532'),
               ('ec37943a-548a-5125-9a19-613a3a53abdb'),
               ('3b602d81-cabd-557f-997c-068454fbf79d'),
               ('a0e5379d-764d-520e-a24a-4b2145bcf7df'),
               ('a4f42d5f-2454-5588-accc-317d10f08b4a'),
               ('407b3714-6d0b-54bf-a688-12ea942b2e12'),
               ('44662000-58dc-5f7b-9612-070634d066f9'),
               ('c1f0f0e3-1ef1-5962-bb58-36bc20f7319c'),
               ('ba04600b-36b2-5562-a29d-13f901e7e14e'),
               ('cdbd88ee-c370-5efb-87d5-809dbab6a4ec'),
               ('82ad310f-dc2c-5a7b-816c-6026ce9ca67b'),
               ('935c5e75-685e-569c-afab-067855207e79'),
               ('d602ad00-65ad-5b20-8edb-e3733be56ddd'),
               ('f5196895-11a3-5c2c-bc5e-74ac7628d5fb'),
               ('427aedd6-1f9e-5cc3-a47a-a9e137cb57be'),
               ('f31de71b-9c80-56b2-9198-ba1f5df3d970'),
               ('2e0ef25c-3c4b-5df8-9b8f-b93f3d930f7d'),
               ('aef0a988-afb1-5edb-895f-34ff8c9af147'),
               ('1f39459b-f8e4-581d-88e0-1f90243efe14'),
               ('9763c1dd-3318-5172-a33d-27f95c0e45af'),
               ('f44b2716-e09b-5e0c-8655-e2f086f43a8a'),
               ('3a3fd540-e054-5bb2-91b4-8f037308dbc1'),
               ('e1371338-7b59-52ed-a055-82b432f10421'),
               ('23c307c6-eda6-5bad-a8ff-ee27877ba767'),
               ('15ec577d-3ef8-5830-8276-b4b90cd4fe38'),
               ('2cd3678a-55a2-5d20-a931-7f5378c8f9ac'),
               ('857c901f-6f27-5549-b5a6-7e18f66fa523'),
               ('35d81505-c029-53c3-b009-4840703b47d0'),
               ('2207da52-bf6f-5b15-83cb-1e466373c594'),
               ('37e89410-99ea-5c26-84df-98dfed957fd3'),
               ('ce00a816-3cd5-5487-a905-be112e375006'),
               ('117800a0-44ce-5e7f-aaf5-b8aa2c6fa5f7'),
               ('c0ae7e00-fe70-5205-aa3a-a5b4135b4841'),
               ('7e396a5d-2e1a-51d8-8b83-8d955f2884c1'),
               ('bec1e679-be44-5ee0-926d-0e8f9982b2aa'),
               ('4961c793-809c-53a8-9608-11471350a116'),
               ('e6a21547-023f-5137-b890-280bae924730'),
               ('74616f3e-7ff6-50f6-8b59-3de4c179b125'),
               ('67af7444-d110-5aec-8b26-0290523ff096'),
               ('67a660f8-ea8b-5281-bd9b-d8e28c28e227'),
               ('1294bccb-8e33-5fc7-a0b0-60173d815f8e'),
               ('0ccedfe1-c09c-51d5-837a-ce2dc1a7ad33'),
               ('6ce0fd15-05fe-5800-966b-2e00f73ad70f'),
               ('a75202d7-8305-588c-a494-24a598474cf2'),
               ('b17e459f-c563-5496-862e-d94bdc6056fd'),
               ('12c312ac-aa5a-5b11-8907-9e5d1196be7c'),
               ('21a4614c-d35e-5e32-8cbe-35877cbac684'),
               ('e265b998-d56a-5b84-b0ff-ca58e238caaa'),
               ('6ecaa0de-cb79-5790-b168-d41d109e9df2'),
               ('90665188-4af6-5f4c-9ae4-5e8809b41007'),
               ('2e52ac64-1816-5225-b6fc-b8fa2819c189'),
               ('d2886f08-39a6-5d7f-a8b2-7de933fb562b'),
               ('3c9a2e8b-b895-5d72-aaf6-74c35c184eaa'),
               ('25a0af45-36dd-5098-9ecf-6454133f8c57'),
               ('f1803b76-41a5-5967-bfb8-0d87e6e624a2'),
               ('bf76cf70-cc48-5f69-9824-0d18b36b535e'),
               ('53f5ac35-50e4-5827-bfaa-dc72e8f63f54'),
               ('deab49d5-9f01-5768-8df9-a3769829b969'),
               ('cc3c7e3a-e899-5817-aaba-87a52711295a'),
               ('9299d39d-d197-5d29-82c3-73b29b9d2ddf'),
               ('4ecdacf1-5965-5823-bed7-dcf846191eac'),
               ('d64ccee6-c6cd-53bc-bd46-3aa1d2423c2e'),
               ('07571b0b-9651-568e-bff7-fbaa495a9133'),
               ('abd2e874-78ff-5229-ae95-5d4e47c06c55'),
               ('e272b1f7-4a49-5384-9820-56cdf0edc489'),
               ('40604864-cff7-568d-abcc-9e412818352c'),
               ('af64be14-198d-5898-a1b7-bd10c23d6e0f'),
               ('80445fe2-2a35-5241-a775-7229567448a8'),
               ('acff38a2-8559-5a82-95c1-a59abab4501e'),
               ('65832dd0-e76d-5f68-8ce7-d949b2febf04'),
               ('ec9e23cc-2131-5241-9416-1737684bc237'),
               ('d46d15f0-a4d7-5921-812c-aa4e2fcdc4c3'),
               ('50b68c96-7685-5c54-8692-460319139687'),
               ('ee12a245-c41b-5b96-b4d3-b50d7267e5ae'),
               ('25d93949-ebc3-5698-9d95-c4df7ce66efb'),
               ('f638902c-c883-53d0-988c-11bd329b4f5d'),
               ('a39cb2af-9544-5e27-972f-7f7e1c34d52d'),
               ('bf750162-6a11-5e13-ab69-d9aba502140b'),
               ('1359ee65-d06c-55a1-9db9-7671318ad129'),
               ('363a7581-d0db-50e4-afc2-88b7fb32550b'),
               ('d618da36-9c28-57be-9ea6-25c99a275003'),
               ('544bf50d-60b3-57de-ab29-f6047fd23127'),
               ('89132353-ebac-5f58-bb12-ca56c5d36656'),
               ('749fb134-94e2-5306-bb86-f427f045ed65'),
               ('bcb59cd7-392c-58b9-ab6d-79ed82ce2d9a')) v(u)
  LEFT JOIN transactions t ON t.id = v.u::uuid;

-- 11b) Migration 010 — categorias raiz (atual) e destino (agregados)
SELECT count(*) FILTER (WHERE id = 'fcc5e03d-af88-50a8-ac0d-de3681734fa8') AS raiz_o_montador_existe,
       count(*) FILTER (WHERE id = '66d5335d-7078-5601-bfbf-c22a5b908f65') AS destino_existe,
       count(*) FILTER (WHERE id = '66d5335d-7078-5601-bfbf-c22a5b908f65'
                          AND profile_id = (SELECT id FROM profiles WHERE code = 'personal')
                          AND direction = 'income' AND status = 'active') AS destino_pessoal_income_active
  FROM categories;

SELECT (SELECT count(*) FROM transactions
         WHERE category_id = 'fcc5e03d-af88-50a8-ac0d-de3681734fa8') AS tx_na_raiz_o_montador,
       (SELECT count(*) FROM transactions
         WHERE category_id = '66d5335d-7078-5601-bfbf-c22a5b908f65') AS tx_no_destino;

-- 11c) Migration 010 — filas RP-MAL-01 abertas do conjunto (19 esperadas)
SELECT count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM reclassification_queue q
            WHERE q.transaction_id = v.u::uuid
              AND q.reason = 'RP-MAL-01' AND q.status = 'open')) AS filas_open_rp_mal_01
  FROM (VALUES ('200d4021-7608-584f-95f4-80818ffa3d79'),
               ('f487c210-6b56-54e9-9cd6-81e25d4c55a8'),
               ('a8fc5c7f-c535-510d-b605-05a9a181eb88'),
               ('49a99caa-d40c-54cf-9f54-2d15d6add75a'),
               ('085d12fb-bee6-5af6-81cb-6352bf0da1d2'),
               ('9eecfb5c-eafa-5724-acc7-fd5f694b75e5'),
               ('f2548e41-90b3-5d43-b568-9ac384b35a67'),
               ('3b602d81-cabd-557f-997c-068454fbf79d'),
               ('407b3714-6d0b-54bf-a688-12ea942b2e12'),
               ('82ad310f-dc2c-5a7b-816c-6026ce9ca67b'),
               ('f5196895-11a3-5c2c-bc5e-74ac7628d5fb'),
               ('2e0ef25c-3c4b-5df8-9b8f-b93f3d930f7d'),
               ('9763c1dd-3318-5172-a33d-27f95c0e45af'),
               ('f44b2716-e09b-5e0c-8655-e2f086f43a8a'),
               ('15ec577d-3ef8-5830-8276-b4b90cd4fe38'),
               ('857c901f-6f27-5549-b5a6-7e18f66fa523'),
               ('ce00a816-3cd5-5487-a905-be112e375006'),
               ('4961c793-809c-53a8-9608-11471350a116'),
               ('67af7444-d110-5aec-8b26-0290523ff096')) v(u);

-- 12) Objetos necessários à migration 011 (existência)
SELECT to_regclass('public.transactions') AS transactions,
       to_regclass('public.accounts') AS accounts,
       to_regclass('public.account_profile_periods') AS account_profile_periods,
       to_regclass('public.categories') AS categories,
       to_regclass('public.transfer_links') AS transfer_links,
       to_regclass('public.reclassification_queue') AS reclassification_queue,
       to_regclass('public.category_assignment_audit') AS category_assignment_audit,
       to_regclass('public.transaction_audit') AS transaction_audit,
       to_regclass('public.schema_migrations') AS schema_migrations;

SELECT extname, extversion
  FROM pg_extension
 WHERE extname IN ('pgcrypto', 'pgjwt')
 ORDER BY 1;

-- 13) Permissões diretas de INSERT/UPDATE/DELETE em transactions (grants e efetivas)
SELECT grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND table_name = 'transactions'
   AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
 ORDER BY grantee, privilege_type;

SELECT 'anon' AS role,
       CASE WHEN to_regclass('public.transactions') IS NULL THEN NULL
            ELSE has_table_privilege('anon', 'public.transactions', 'INSERT') END AS can_insert,
       CASE WHEN to_regclass('public.transactions') IS NULL THEN NULL
            ELSE has_table_privilege('anon', 'public.transactions', 'UPDATE') END AS can_update,
       CASE WHEN to_regclass('public.transactions') IS NULL THEN NULL
            ELSE has_table_privilege('anon', 'public.transactions', 'DELETE') END AS can_delete
UNION ALL
SELECT 'authenticated' AS role,
       CASE WHEN to_regclass('public.transactions') IS NULL THEN NULL
            ELSE has_table_privilege('authenticated', 'public.transactions', 'INSERT') END AS can_insert,
       CASE WHEN to_regclass('public.transactions') IS NULL THEN NULL
            ELSE has_table_privilege('authenticated', 'public.transactions', 'UPDATE') END AS can_update,
       CASE WHEN to_regclass('public.transactions') IS NULL THEN NULL
            ELSE has_table_privilege('authenticated', 'public.transactions', 'DELETE') END AS can_delete
UNION ALL
SELECT 'service_role' AS role,
       CASE WHEN to_regrole('service_role') IS NULL THEN NULL
            ELSE has_table_privilege('service_role', 'public.transactions', 'INSERT') END AS can_insert,
       CASE WHEN to_regrole('service_role') IS NULL THEN NULL
            ELSE has_table_privilege('service_role', 'public.transactions', 'UPDATE') END AS can_update,
       CASE WHEN to_regrole('service_role') IS NULL THEN NULL
            ELSE has_table_privilege('service_role', 'public.transactions', 'DELETE') END AS can_delete;

-- 14a) Acessibilidade PostgREST: EXECUTE por papel nas RPCs (se existirem)
SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS args,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       CASE WHEN to_regrole('service_role') IS NULL THEN NULL
            ELSE has_function_privilege('service_role', p.oid, 'EXECUTE') END AS service_exec
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.proname IN ('assign_category_atomic', 'transaction_create',
                     'transaction_update', 'transaction_get_detail')
   AND n.nspname IN ('public', 'app')
 ORDER BY 1, 2, 3;

-- 14b) Schemas configurados para o autenticador/PostgREST (se visível)
SELECT rolname, rolconfig
  FROM pg_roles
 WHERE rolname = 'authenticator';

SELECT current_setting('pgrst.db_schemas', true) AS pgrst_db_schemas;

-- READ-ONLY: este arquivo não contém DDL, DML ou chamadas de RPC.
-- ============================================================
-- PREFLIGHT_CLOUD_009_012_READONLY.sql
-- Verificação imediatamente ANTES da aplicação do pacote Cloud 009-012.
-- UMA única statement SELECT -> UMA grade exportável:
--   ord | stage | status (PASS/BLOCKED) | detail (jsonb)
-- Não escreve nada. Se qualquer etapa der BLOCKED, NÃO aplicar o pacote.
-- ============================================================

SELECT * FROM (

SELECT 1 AS ord, 'stg_009_isolation' AS stage,
       CASE WHEN (SELECT count(*) FROM pg_policies
                   WHERE schemaname='public' AND tablename='categories'
                     AND policyname='categories_select_auth') = 1
             AND (SELECT count(*) FROM pg_policies
                   WHERE schemaname='public' AND tablename='categories'
                     AND policyname='categories_select_own') = 0
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'esperado', 'ampla presente e isolada ausente',
           'ampla_existe', (SELECT count(*) FROM pg_policies
                             WHERE schemaname='public' AND tablename='categories'
                               AND policyname='categories_select_auth'),
           'isolada_existe', (SELECT count(*) FROM pg_policies
                               WHERE schemaname='public' AND tablename='categories'
                                 AND policyname='categories_select_own')
       ) AS detail

UNION ALL

SELECT 2 AS ord, 'stg_010_interpj' AS stage,
       CASE WHEN
         (SELECT count(t.id) FROM (VALUES ('15e6da49-7d1f-5ae4-a936-f099a148cf6d'),
                                           ('38886977-8e8e-5c32-b8e8-6f2ec67edea5'),
                                           ('d0b03c47-a82f-57a7-a368-2e123af90d93')) v(u)
            LEFT JOIN transactions t ON t.id = v.u::uuid
           WHERE t.id IS NOT NULL) = 3
         AND (SELECT count(*) FROM (VALUES ('15e6da49-7d1f-5ae4-a936-f099a148cf6d'),
                                           ('38886977-8e8e-5c32-b8e8-6f2ec67edea5'),
                                           ('d0b03c47-a82f-57a7-a368-2e123af90d93')) v(u)
              JOIN reclassification_queue q ON q.transaction_id = v.u::uuid) = 0
         AND (SELECT count(*) FROM (VALUES ('15e6da49-7d1f-5ae4-a936-f099a148cf6d'),
                                           ('38886977-8e8e-5c32-b8e8-6f2ec67edea5'),
                                           ('d0b03c47-a82f-57a7-a368-2e123af90d93')) v(u)
              JOIN category_assignment_audit a ON a.transaction_id = v.u::uuid) = 0
         AND (SELECT count(*) FROM (VALUES ('15e6da49-7d1f-5ae4-a936-f099a148cf6d'),
                                           ('38886977-8e8e-5c32-b8e8-6f2ec67edea5'),
                                           ('d0b03c47-a82f-57a7-a368-2e123af90d93')) v(u)
              JOIN transfer_links l ON l.out_transaction_id = v.u::uuid
                                   OR l.in_transaction_id  = v.u::uuid) = 0
         AND (SELECT count(*) FROM categories
               WHERE id='1b1911d6-2c15-503a-95da-f859f33af83c') = 1
         AND (SELECT count(*) FROM transactions WHERE category_id='1b1911d6-2c15-503a-95da-f859f33af83c') = 39
         AND (SELECT count(*) FROM categories WHERE id='30000000-0000-4000-8000-000000000009') = 0
        THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'esperado', '3 Inter PJ Pessoal/expense sem filas/auditorias/links; Ads com 39 txs; raiz Marketing ausente',
           'existentes', (SELECT count(t.id) FROM (VALUES ('15e6da49-7d1f-5ae4-a936-f099a148cf6d'),
                                                            ('38886977-8e8e-5c32-b8e8-6f2ec67edea5'),
                                                            ('d0b03c47-a82f-57a7-a368-2e123af90d93')) v(u)
                           LEFT JOIN transactions t ON t.id = v.u::uuid),
           'filas', (SELECT count(*) FROM (VALUES ('15e6da49-7d1f-5ae4-a936-f099a148cf6d'),
                                                    ('38886977-8e8e-5c32-b8e8-6f2ec67edea5'),
                                                    ('d0b03c47-a82f-57a7-a368-2e123af90d93')) v(u)
                      JOIN reclassification_queue q ON q.transaction_id = v.u::uuid),
           'auditorias', (SELECT count(*) FROM (VALUES ('15e6da49-7d1f-5ae4-a936-f099a148cf6d'),
                                                         ('38886977-8e8e-5c32-b8e8-6f2ec67edea5'),
                                                         ('d0b03c47-a82f-57a7-a368-2e123af90d93')) v(u)
                           JOIN category_assignment_audit a ON a.transaction_id = v.u::uuid),
           'links', (SELECT count(*) FROM (VALUES ('15e6da49-7d1f-5ae4-a936-f099a148cf6d'),
                                                    ('38886977-8e8e-5c32-b8e8-6f2ec67edea5'),
                                                    ('d0b03c47-a82f-57a7-a368-2e123af90d93')) v(u)
                      JOIN transfer_links l ON l.out_transaction_id = v.u::uuid
                                           OR l.in_transaction_id  = v.u::uuid),
           'ads_existe', (SELECT count(*) FROM categories WHERE id='1b1911d6-2c15-503a-95da-f859f33af83c'),
           'ads_n_transacoes', (SELECT count(*) FROM transactions WHERE category_id='1b1911d6-2c15-503a-95da-f859f33af83c'),
           'raiz_marketing_existe', (SELECT count(*) FROM categories WHERE id='30000000-0000-4000-8000-000000000009')
       ) AS detail

UNION ALL

SELECT 3 AS ord, 'stg_011_montador' AS stage,
       CASE WHEN
         (SELECT count(t.id) FROM (VALUES ('200d4021-7608-584f-95f4-80818ffa3d79'),
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
            LEFT JOIN transactions t ON t.id = v.u::uuid
           WHERE t.id IS NOT NULL) = 100
         AND (SELECT sum(t.amount) FROM (VALUES ('200d4021-7608-584f-95f4-80818ffa3d79'),
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
            LEFT JOIN transactions t ON t.id = v.u::uuid) = 326876.52
         AND (SELECT count(*) FROM transactions WHERE category_id='66d5335d-7078-5601-bfbf-c22a5b908f65') = 0
         AND (SELECT count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM reclassification_queue q
                 WHERE q.transaction_id = v.u::uuid
                   AND q.reason = 'RP-MAL-01' AND q.status = 'open'))
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
                             ('67af7444-d110-5aec-8b26-0290523ff096')) v(u)) = 19
        THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'esperado', '100 ids Pessoal/expense soma 326876.52 (64/19/17); destino vazio; 19 filas RP-MAL-01 open',
           'existentes', (SELECT count(t.id) FROM (VALUES ('200d4021-7608-584f-95f4-80818ffa3d79'),
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
            LEFT JOIN transactions t ON t.id = v.u::uuid),
           'soma', (SELECT sum(t.amount) FROM (VALUES ('200d4021-7608-584f-95f4-80818ffa3d79'),
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
            LEFT JOIN transactions t ON t.id = v.u::uuid),
           'destino_tx', (SELECT count(*) FROM transactions WHERE category_id='66d5335d-7078-5601-bfbf-c22a5b908f65'),
           'filas_open_rp_mal', (SELECT count(*) FILTER (WHERE EXISTS (
                                  SELECT 1 FROM reclassification_queue q
                                   WHERE q.transaction_id = v.u::uuid
                                     AND q.reason = 'RP-MAL-01' AND q.status = 'open'))
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
                                               ('67af7444-d110-5aec-8b26-0290523ff096')) v(u))
       ) AS detail

UNION ALL

SELECT 4 AS ord, 'stg_012_crud_ausente' AS stage,
       CASE WHEN to_regclass('public.transaction_audit') IS NULL
             AND NOT EXISTS (SELECT 1 FROM pg_proc p
                              JOIN pg_namespace n ON n.oid = p.pronamespace
                             WHERE p.proname = 'transaction_create'
                               AND n.nspname IN ('public', 'app'))
             AND NOT EXISTS (SELECT 1 FROM pg_proc p
                              JOIN pg_namespace n ON n.oid = p.pronamespace
                             WHERE p.proname = 'transaction_update'
                               AND n.nspname IN ('public', 'app'))
             AND NOT EXISTS (SELECT 1 FROM pg_proc p
                              JOIN pg_namespace n ON n.oid = p.pronamespace
                             WHERE p.proname = 'transaction_get_detail'
                               AND n.nspname IN ('public', 'app'))
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'esperado', 'transaction_audit e funcoes CRUD ausentes',
           'transaction_audit', to_regclass('public.transaction_audit'),
           'fn_create', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                          WHERE p.proname='transaction_create' AND n.nspname IN ('public','app')),
           'fn_update', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                          WHERE p.proname='transaction_update' AND n.nspname IN ('public','app')),
           'fn_detail', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                          WHERE p.proname='transaction_get_detail' AND n.nspname IN ('public','app'))
       ) AS detail

UNION ALL

SELECT 5 AS ord, 'stg_grants_pre' AS stage,
       CASE WHEN has_table_privilege('authenticated', 'public.transactions', 'INSERT')
             AND has_table_privilege('authenticated', 'public.transactions', 'UPDATE')
             AND has_table_privilege('authenticated', 'public.transactions', 'DELETE')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'esperado', 'grants diretos de escrita de authenticated presentes (pre-012; serao revogados pelo 012)',
           'authenticated_insert', has_table_privilege('authenticated', 'public.transactions', 'INSERT'),
           'authenticated_update', has_table_privilege('authenticated', 'public.transactions', 'UPDATE'),
           'authenticated_delete', has_table_privilege('authenticated', 'public.transactions', 'DELETE'),
           'anon_write', has_table_privilege('anon', 'public.transactions', 'INSERT')
       ) AS detail

UNION ALL

SELECT 6 AS ord, 'stg_runtime' AS stage,
       CASE WHEN split_part(current_setting('server_version'), '.', 1)::int >= 14
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'database', current_database(),
           'role', current_user,
           'server_version', current_setting('server_version'),
           'pgcrypto', (SELECT coalesce(extversion, 'AUSENTE') FROM pg_extension WHERE extname='pgcrypto'),
           'jwt_profile_id', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                               WHERE p.proname='jwt_profile_id' AND n.nspname='app')
       ) AS detail

UNION ALL

SELECT 7 AS ord, 'stg_schema_create' AS stage,
       CASE WHEN NOT has_schema_privilege('anon', 'public', 'CREATE')
             AND NOT has_schema_privilege('authenticated', 'public', 'CREATE')
             AND NOT has_schema_privilege('anon', 'app', 'CREATE')
             AND NOT has_schema_privilege('authenticated', 'app', 'CREATE')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'public_acl', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                              'grantee', coalesce(r.rolname, 'PUBLIC'),
                              'privilege', acl.privilege_type) ORDER BY 2), '[]'::jsonb)
                            FROM pg_namespace n
                            CROSS JOIN LATERAL aclexplode(n.nspacl) acl
                            JOIN pg_roles r ON r.oid = acl.grantee
                           WHERE n.nspname = 'public'),
           'app_acl', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                          'grantee', coalesce(r.rolname, 'PUBLIC'),
                          'privilege', acl.privilege_type) ORDER BY 2), '[]'::jsonb)
                        FROM pg_namespace n
                        CROSS JOIN LATERAL aclexplode(n.nspacl) acl
                        JOIN pg_roles r ON r.oid = acl.grantee
                       WHERE n.nspname = 'app'),
           'anon_create_public', has_schema_privilege('anon', 'public', 'CREATE'),
           'authenticated_create_public', has_schema_privilege('authenticated', 'public', 'CREATE'),
           'authenticated_create_app', has_schema_privilege('authenticated', 'app', 'CREATE'),
           'nota', 'CREATE em public/app por anon/authenticated abre shadowing de objetos nao qualificados. A 012 qualifica todas as tabelas (public.*) e chama app.* e pg_catalog qualificados/implicitos - se esta etapa der BLOCKED, revogar o CREATE OU aceitar explicitamente o risco documentado'
       ) AS detail

) s
ORDER BY ord;
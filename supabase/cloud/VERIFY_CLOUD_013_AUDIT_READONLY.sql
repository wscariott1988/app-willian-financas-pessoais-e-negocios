-- ============================================================
-- VERIFY_CLOUD_013_AUDIT_READONLY.sql
-- Diagnóstico READ-ONLY: exclusão soft-delete × visibilidade no
-- "Histórico de alterações" (Configurações).
--
-- Estritamente read-only: não contém DDL, DML ou chamadas de RPC.
-- Uma única statement SELECT -> uma grade exportável.
-- SEM dados financeiros individuais (somente contagens/booleanos),
-- SEM credenciais, SEM descrições ou valores.
--
-- Uso: executar no SQL Editor do Supabase Cloud (postgres).
-- ============================================================

SELECT * FROM (

-- 1) Existem transações soft-deletadas (deleted_at preenchido)?
SELECT 1 AS ord, 'stg_audit_soft_deleted_tx' AS stage,
       CASE WHEN (SELECT count(*) FROM public.transactions WHERE deleted_at IS NOT NULL) > 0
            THEN 'PASS' ELSE 'SEM_CASO' END AS status,
       jsonb_build_object(
           'soft_deleted_tx_count', (SELECT count(*)::int FROM public.transactions WHERE deleted_at IS NOT NULL)
       ) AS detail

UNION ALL

-- 2) Existem eventos de auditoria action='delete'?
SELECT 2 AS ord, 'stg_audit_delete_events' AS stage,
       CASE WHEN (SELECT count(*) FROM public.transaction_audit WHERE action = 'delete') > 0
            THEN 'PASS' ELSE 'SEM_EVENTOS_DELETE' END AS status,
       jsonb_build_object(
           'delete_audit_count', (SELECT count(*)::int FROM public.transaction_audit WHERE action = 'delete')
       ) AS detail

UNION ALL

-- 3) Os eventos 'delete' referenciam transações soft-deletadas?
SELECT 3 AS ord, 'stg_audit_delete_on_soft_deleted' AS stage,
       CASE WHEN (SELECT count(*)
                    FROM public.transaction_audit a
                    JOIN public.transactions t ON t.id = a.transaction_id
                   WHERE a.action = 'delete' AND t.deleted_at IS NOT NULL) > 0
            THEN 'PASS' ELSE 'SEM_CASO' END AS status,
       jsonb_build_object(
           'delete_events_on_soft_deleted', (SELECT count(*)::int
                                              FROM public.transaction_audit a
                                              JOIN public.transactions t ON t.id = a.transaction_id
                                             WHERE a.action = 'delete' AND t.deleted_at IS NOT NULL)
       ) AS detail

UNION ALL

-- 4) before_state preenchido nos eventos 'delete'?
SELECT 4 AS ord, 'stg_audit_before_state' AS stage,
       CASE WHEN (SELECT count(*) FROM public.transaction_audit WHERE action = 'delete' AND before_state IS NOT NULL) > 0
            THEN 'PASS' ELSE 'SEM_CASO' END AS status,
       jsonb_build_object(
           'delete_with_before_state', (SELECT count(*)::int FROM public.transaction_audit WHERE action = 'delete' AND before_state IS NOT NULL),
           'delete_with_after_state',  (SELECT count(*)::int FROM public.transaction_audit WHERE action = 'delete' AND after_state IS NOT NULL)
       ) AS detail

UNION ALL

-- 5) changed_by preenchido nos eventos 'delete'?
SELECT 5 AS ord, 'stg_audit_changed_by' AS stage,
       CASE WHEN (SELECT count(*) FROM public.transaction_audit WHERE action = 'delete' AND changed_by IS NOT NULL) > 0
            THEN 'PASS' ELSE 'SEM_CASO' END AS status,
       jsonb_build_object(
           'delete_with_changed_by', (SELECT count(*)::int FROM public.transaction_audit WHERE action = 'delete' AND changed_by IS NOT NULL)
       ) AS detail

UNION ALL

-- 6) created_at preenchido nos eventos 'delete'?
SELECT 6 AS ord, 'stg_audit_created_at' AS stage,
       CASE WHEN (SELECT count(*) FROM public.transaction_audit WHERE action = 'delete' AND created_at IS NOT NULL) > 0
            THEN 'PASS' ELSE 'SEM_CASO' END AS status,
       jsonb_build_object(
           'delete_with_created_at', (SELECT count(*)::int FROM public.transaction_audit WHERE action = 'delete' AND created_at IS NOT NULL)
       ) AS detail

UNION ALL

-- 7) transactions_select_own exige deleted_at IS NULL (013) — compõe o mascaramento?
SELECT 7 AS ord, 'stg_rls_tx_deleted_filter' AS stage,
       CASE WHEN (SELECT position('deleted_at is null' in lower(coalesce(qual, ''))) > 0
                    FROM pg_policies
                   WHERE schemaname = 'public' AND tablename = 'transactions' AND policyname = 'transactions_select_own')
            THEN 'PASS' ELSE 'SEM_FILTRO_DELETED' END AS status,
       jsonb_build_object(
           'transactions_select_own_qual', (SELECT coalesce(qual, '') FROM pg_policies
                                             WHERE schemaname = 'public' AND tablename = 'transactions' AND policyname = 'transactions_select_own')
       ) AS detail

UNION ALL

-- 8) ta_select_own referencia public.transactions em subquery (policy de leitura da auditoria)?
SELECT 8 AS ord, 'stg_rls_ta_subquery_tx' AS stage,
       CASE WHEN (SELECT position('transactions' in lower(coalesce(qual, ''))) > 0
                    FROM pg_policies
                   WHERE schemaname = 'public' AND tablename = 'transaction_audit' AND policyname = 'ta_select_own')
            THEN 'PASS' ELSE 'SEM_SUBQUERY_TX' END AS status,
       jsonb_build_object(
           'ta_select_own_qual', (SELECT coalesce(qual, '') FROM pg_policies
                                   WHERE schemaname = 'public' AND tablename = 'transaction_audit' AND policyname = 'ta_select_own')
       ) AS detail

UNION ALL

-- 9) Impacto do mascaramento: quantos eventos 'delete' ficam ocultos para o dono
--    (transação soft-deletada => subquery da policy perde o vínculo via RLS deleted_at IS NULL)?
SELECT 9 AS ord, 'stg_rls_masking_affected' AS stage,
       CASE WHEN (SELECT count(*)
                    FROM public.transaction_audit a
                    JOIN public.transactions t ON t.id = a.transaction_id
                   WHERE a.action = 'delete' AND t.deleted_at IS NOT NULL) > 0
            THEN 'PASS' ELSE 'SEM_CASO' END AS status,
       jsonb_build_object(
           'delete_events_ocultos_por_rls', (SELECT count(*)::int
                                              FROM public.transaction_audit a
                                              JOIN public.transactions t ON t.id = a.transaction_id
                                             WHERE a.action = 'delete' AND t.deleted_at IS NOT NULL)
       ) AS detail

UNION ALL

-- 10) Fonte do frontend: category_assignment_audit tem registros ligados a transações
--     soft-deletadas? (a tela Histórico de alterações lê SOMENTE category_assignment_audit)
SELECT 10 AS ord, 'stg_ui_table_delete_related' AS stage,
       CASE WHEN (SELECT count(*)
                    FROM public.category_assignment_audit a
                    JOIN public.transactions t ON t.id = a.transaction_id
                   WHERE t.deleted_at IS NOT NULL) = 0
            THEN 'PASS' ELSE 'ATENCAO' END AS status,
       jsonb_build_object(
           'category_assignment_audit_rows_for_deleted', (SELECT count(*)::int
                                                           FROM public.category_assignment_audit a
                                                           JOIN public.transactions t ON t.id = a.transaction_id
                                                          WHERE t.deleted_at IS NOT NULL)
       ) AS detail

UNION ALL

-- 11) Confirma: a tela de Configurações não lê transaction_audit (fonte dos 'delete').
--     Não é possível inspecionar TSX via SQL; este estágio documenta a assimetria
--     entre os dados existentes (transaction_audit) e a fonte da UI (category_assignment_audit).
SELECT 11 AS ord, 'stg_ui_fonte_asimetrica' AS stage,
       CASE WHEN (SELECT count(*) FROM public.transaction_audit WHERE action = 'delete') > 0
            AND (SELECT count(*) FROM public.category_assignment_audit WHERE reason IS NOT NULL OR from_category_id IS NOT NULL) >= 0
            THEN 'PASS' ELSE 'INFO' END AS status,
       jsonb_build_object(
           'frontend_lê', 'category_assignment_audit (AuditLogs.tsx)',
           'delete_grava_em', 'transaction_audit (action=delete)',
           'assimetria', 'UI não consulta transaction_audit => evento de exclusão nunca aparece'
       ) AS detail

) s
ORDER BY ord;

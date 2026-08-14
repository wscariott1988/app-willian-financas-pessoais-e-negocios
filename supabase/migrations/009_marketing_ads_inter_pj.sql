-- 009_marketing_ads_inter_pj.sql
-- Etapa local de reconciliacao: raiz "Marketing e publicidade" (Negocio/expense),
-- reparenting da categoria Ads existente e transferencia das tres despesas
-- Inter PJ para o Perfil Negocio.
--
-- Decisao do proprietario registrada na auditoria 1.2A.4B.3 (relatorio):
--   * Ads e Despesa e nao pode permanecer filho de "Trafego Pago" (Receita);
--   * as tres despesas facebook/facebook ads da conta Inter PJ pertencem ao
--     Perfil Negocio e devem terminar em "Marketing e publicidade > Ads";
--   * nao criar segunda categoria Ads (reutilizar 1b1911d6-...);
--   * nao alterar Google ads, Receita > Google Ads Gestao, Trafego Pago nem
--     Gestor de trafego.
--
-- UUID deterministico e documentado da nova raiz:
--   30000000-0000-4000-8000-000000000009  (prefixo 3000... + sufixo 0009 = migration 009)
--
-- Execucao em transacao unica; qualquer assertion divergente faz rollback completo.
-- Nao cria tabelas novas; auditoria usa category_assignment_audit existente.

BEGIN;

DO $$
DECLARE
    v_business uuid := (SELECT id FROM profiles WHERE code = 'business');
    v_pessoal  uuid := (SELECT id FROM profiles WHERE code = 'personal');
    v_ads      uuid := '1b1911d6-2c15-503a-95da-f859f33af83c';
    v_trafego  uuid := '224f5e21-47fa-5323-9e06-0ffe170c626d';
    v_t1       uuid := '15e6da49-7d1f-5ae4-a936-f099a148cf6d';
    v_t2       uuid := '38886977-8e8e-5c32-b8e8-6f2ec67edea5';
    v_t3       uuid := 'd0b03c47-a82f-57a7-a368-2e123af90d93';
    n          integer;
BEGIN
    -- 1) Ads: Negocio/expense/active, pai atual = Trafego Pago, zero filhos
    IF NOT EXISTS (SELECT 1 FROM categories
                   WHERE id = v_ads AND profile_id = v_business
                     AND direction = 'expense' AND status = 'active'
                     AND parent_id = v_trafego) THEN
        RAISE EXCEPTION '009: categoria Ads fora do estado esperado';
    END IF;
    IF EXISTS (SELECT 1 FROM categories WHERE parent_id = v_ads) THEN
        RAISE EXCEPTION '009: Ads possui filhos (nao esperado)';
    END IF;

    -- 2) Ads com exatamente 39 transacoes historicas, todas expense
    IF (SELECT count(*) FROM transactions WHERE category_id = v_ads) <> 39 THEN
        RAISE EXCEPTION '009: Ads nao possui exatamente 39 transacoes';
    END IF;
    IF EXISTS (SELECT 1 FROM transactions
               WHERE category_id = v_ads AND transaction_kind <> 'expense') THEN
        RAISE EXCEPTION '009: existe transacao nao expense em Ads';
    END IF;

    -- 3) raiz "Marketing e publicidade" inexistente no Negocio/expense
    IF EXISTS (SELECT 1 FROM categories
               WHERE profile_id = v_business AND direction = 'expense'
                 AND parent_id IS NULL
                 AND normalized_name = 'marketing e publicidade') THEN
        RAISE EXCEPTION '009: raiz Marketing e publicidade ja existe';
    END IF;

    -- 4) as tres transacoes: existem, Pessoal, expense, sem fila/auditoria/transfer
    SELECT count(*) INTO n FROM transactions
     WHERE id IN (v_t1, v_t2, v_t3)
       AND profile_id = v_pessoal AND transaction_kind = 'expense';
    IF n <> 3 THEN
        RAISE EXCEPTION '009: transacoes Inter PJ fora do estado esperado (esperadas 3 Pessoal/expense)';
    END IF;
    IF EXISTS (SELECT 1 FROM reclassification_queue WHERE transaction_id IN (v_t1, v_t2, v_t3)) THEN
        RAISE EXCEPTION '009: fila de revisao existente nas tres transacoes';
    END IF;
    IF EXISTS (SELECT 1 FROM category_assignment_audit WHERE transaction_id IN (v_t1, v_t2, v_t3)) THEN
        RAISE EXCEPTION '009: auditoria existente nas tres transacoes';
    END IF;
    IF EXISTS (SELECT 1 FROM transfer_links
               WHERE out_transaction_id IN (v_t1, v_t2, v_t3)
                  OR in_transaction_id  IN (v_t1, v_t2, v_t3)) THEN
        RAISE EXCEPTION '009: transfer link existente nas tres transacoes';
    END IF;
END $$;

-- cria a raiz Marketing e publicidade (Negocio/expense/active, sem pai)
INSERT INTO categories (id, profile_id, direction, parent_id,
                        source_name, display_name, normalized_name, canonical_path, status)
VALUES (
    '30000000-0000-4000-8000-000000000009',
    (SELECT id FROM profiles WHERE code = 'business'),
    'expense', NULL,
    'Marketing e publicidade', 'Marketing e publicidade',
    'marketing e publicidade', 'Marketing e publicidade', 'active'
);

-- reparenting da categoria Ads existente para a nova raiz + caminho final
UPDATE categories
   SET parent_id      = '30000000-0000-4000-8000-000000000009',
       canonical_path = 'Marketing e publicidade > Ads'
 WHERE id = '1b1911d6-2c15-503a-95da-f859f33af83c';

-- auditoria ANTES da mudanca das transacoes (from_category_id = categoria atual real)
INSERT INTO category_assignment_audit
    (id, transaction_id, queue_item_id, from_category_id, to_category_id, assigned_by, reason)
SELECT gen_random_uuid(), t.id, NULL, t.category_id,
       '1b1911d6-2c15-503a-95da-f859f33af83c', NULL,
       'migration_009:owner_decision:inter_pj_ads'
  FROM transactions t
 WHERE t.id IN ('15e6da49-7d1f-5ae4-a936-f099a148cf6d',
                '38886977-8e8e-5c32-b8e8-6f2ec67edea5',
                'd0b03c47-a82f-57a7-a368-2e123af90d93');

-- transferencia das tres despesas para o Perfil Negocio + categoria Ads
UPDATE transactions
   SET profile_id  = (SELECT id FROM profiles WHERE code = 'business'),
       category_id = '1b1911d6-2c15-503a-95da-f859f33af83c'
 WHERE id IN ('15e6da49-7d1f-5ae4-a936-f099a148cf6d',
              '38886977-8e8e-5c32-b8e8-6f2ec67edea5',
              'd0b03c47-a82f-57a7-a368-2e123af90d93');

-- validacao posterior: zero cruzamento transacao x categoria por perfil
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM transactions t
               JOIN categories c ON c.id = t.category_id
               WHERE t.profile_id <> c.profile_id) THEN
        RAISE EXCEPTION '009: cruzamento transacao x categoria por perfil apos a migracao';
    END IF;
END $$;

COMMIT;

-- 005_functions.sql - Fase 4B
-- Função atômica de atribuição de categoria (fluxo vertical):
--   1) valida propriedade (perfil do token = perfil da transação);
--   2) valida categoria compatível (perfil + direção + ativa);
--   3) atualiza transactions (categoria + transaction_kind);
--   4) fecha o item CORRETO da fila (mesma transação, aberto, prioridade documentada);
--   5) insere category_assignment_audit;
--   tudo em uma transação: qualquer violação faz rollback completo.

CREATE OR REPLACE FUNCTION app.assign_category_atomic(
    p_transaction_id uuid,
    p_category_id    uuid,
    p_profile_id     uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_tx_profile   uuid;
    v_tx_kind      text;
    v_old_category uuid;
    v_cat_profile  uuid;
    v_cat_direction text;
    v_cat_status   text;
    v_closed_queue uuid;
    v_audit_id     uuid;
BEGIN
    -- ownership: o perfil do token precisa ser dono da transação
    SELECT profile_id, transaction_kind, category_id
      INTO v_tx_profile, v_tx_kind, v_old_category
      FROM transactions WHERE id = p_transaction_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'transacao % nao encontrada', p_transaction_id;
    END IF;
    IF v_tx_profile <> p_profile_id THEN
        RAISE EXCEPTION 'perfil do token nao possui a transacao %', p_transaction_id;
    END IF;

    -- categoria: perfil + ativa
    SELECT profile_id, direction, status
      INTO v_cat_profile, v_cat_direction, v_cat_status
      FROM categories WHERE id = p_category_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'categoria % nao encontrada', p_category_id;
    END IF;
    IF v_cat_profile <> p_profile_id THEN
        RAISE EXCEPTION 'categoria % pertence a outro perfil', p_category_id;
    END IF;
    IF v_cat_status <> 'active' THEN
        RAISE EXCEPTION 'categoria % nao esta ativa', p_category_id;
    END IF;

    -- direção compatível (transferências não recebem categoria de receita/despesa)
    IF v_tx_kind = 'transfer' THEN
        RAISE EXCEPTION 'transacao de transferencia nao recebe categoria';
    END IF;
    IF v_cat_direction <> v_tx_kind THEN
        RAISE EXCEPTION 'categoria de direcao % incompativel com transacao % (kind %)',
            v_cat_direction, p_transaction_id, v_tx_kind;
    END IF;

    -- 3) atualiza a transação
    UPDATE transactions
       SET category_id = p_category_id,
           transaction_kind = v_cat_direction,
           updated_at = now()
     WHERE id = p_transaction_id;

    -- 4) fecha o item correto da fila:
    --    prioridade documentada: sem_categoria > sem_correspondencia > motivos de revisão (RP-*)
    UPDATE reclassification_queue
       SET status = 'closed', closed_at = now()
     WHERE id = (
           SELECT id FROM reclassification_queue
            WHERE transaction_id = p_transaction_id AND status = 'open'
            ORDER BY CASE reason
                       WHEN 'sem_categoria' THEN 1
                       WHEN 'sem_correspondencia' THEN 2
                       ELSE 3
                     END,
                     created_at
            LIMIT 1
           FOR UPDATE SKIP LOCKED
     )
     RETURNING id INTO v_closed_queue;

    -- 5) auditoria
    INSERT INTO category_assignment_audit
        (id, transaction_id, queue_item_id, from_category_id, to_category_id,
         assigned_by, reason, created_at)
    VALUES
        (gen_random_uuid(), p_transaction_id, v_closed_queue, v_old_category,
         p_category_id, p_profile_id, 'assign_category_atomic', now())
    RETURNING id INTO v_audit_id;

    RETURN jsonb_build_object(
        'transaction_id', p_transaction_id,
        'category_id', p_category_id,
        'from_category_id', v_old_category,
        'queue_item_id', v_closed_queue,
        'audit_id', v_audit_id
    );
END;
$$;

GRANT EXECUTE ON FUNCTION app.assign_category_atomic(uuid, uuid, uuid) TO authenticated;

-- ============================================================
-- 013_cloud_transaction_delete.sql
-- Exclusão segura via soft-delete (deleted_at).
-- Preserva todas as FKs, auditoria e integridade.
-- Para transferências: remove ambas as pontas + vínculo atomicamente.
-- Adaptada ao Supabase Cloud com HARDENING (mesmos padrões do 012):
--   * funcoes SECURITY DEFINER com search_path fixo 'public, app';
--   * referencias TOTALMENTE QUALIFICADAS (public.*);
--   * wrapper public com nomes EXATOS do payload do frontend;
--   * grants minimos (authenticated apenas).
-- ============================================================

-- 0) Colunas deleted_at
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;
ALTER TABLE public.transfer_links ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_not_deleted ON public.transactions (id) WHERE deleted_at IS NULL;

-- 0b) Expandir CHECK de transaction_audit para aceitar 'delete'
ALTER TABLE public.transaction_audit DROP CONSTRAINT IF EXISTS transaction_audit_action_check;
ALTER TABLE public.transaction_audit ADD CONSTRAINT transaction_audit_action_check
  CHECK (action IN ('create', 'update', 'delete'));

-- 1) RLS: ocultar transações soft-deletadas de SELECT para o perfil
DROP POLICY IF EXISTS transactions_select_own ON public.transactions;
CREATE POLICY transactions_select_own ON public.transactions FOR SELECT
  USING (
    app.jwt_role() = 'service_role'
    OR (profile_id = app.jwt_profile_id() AND deleted_at IS NULL)
  );

-- 2) Guard em transaction_update: impedir edição de transação já excluída
CREATE OR REPLACE FUNCTION app.transaction_update(
    p_transaction_id      uuid,
    p_expected_updated_at timestamptz,
    p_kind                text,
    p_description         text,
    p_amount              numeric,
    p_occurred_on         date,
    p_account_id          uuid,
    p_to_account_id       uuid DEFAULT NULL,
    p_category_id         uuid DEFAULT NULL,
    p_status              text DEFAULT NULL,
    p_memo                text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_cur     public.transactions%ROWTYPE;
    v_sub     uuid;
BEGIN
    SELECT * INTO v_cur
      FROM public.transactions WHERE id = p_transaction_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'transacao % nao encontrada', p_transaction_id;
    END IF;

    IF v_cur.profile_id <> app.jwt_profile_id() THEN
        RAISE EXCEPTION 'perfil do token nao possui a transacao %', p_transaction_id;
    END IF;

    IF v_cur.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'transacao % ja foi excluida', p_transaction_id;
    END IF;

    IF p_expected_updated_at IS NOT NULL
       AND abs(extract(epoch FROM (v_cur.updated_at - p_expected_updated_at))) > 0.001
    THEN
        RAISE EXCEPTION 'CONFLITO: transacao foi modificada por outra operacao';
    END IF;

    UPDATE public.transactions
       SET account_id             = p_account_id,
           category_id            = COALESCE(p_category_id, category_id),
           transaction_kind       = p_kind,
           amount                 = p_amount,
           occurred_on            = p_occurred_on,
           raw_description        = p_description,
           normalized_description = p_description,
           status                 = COALESCE(p_status, status),
           memo                   = p_memo,
           updated_at             = now()
     WHERE id = p_transaction_id;

    PERFORM app.close_all_open_queue(p_transaction_id);

    RETURN to_jsonb(v_cur.*) || jsonb_build_object(
        'transaction_id', p_transaction_id,
        'updated_at',     (SELECT updated_at FROM public.transactions WHERE id = p_transaction_id)
    );
END;
$$;

-- 3) Guard em assign_category_atomic: impedir re-categorização de transação excluída
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
    SELECT profile_id, transaction_kind, category_id
      INTO v_tx_profile, v_tx_kind, v_old_category
      FROM public.transactions WHERE id = p_transaction_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'transacao % nao encontrada', p_transaction_id;
    END IF;
    IF v_tx_profile <> p_profile_id THEN
        RAISE EXCEPTION 'perfil do token nao possui a transacao %', p_transaction_id;
    END IF;
    IF (SELECT deleted_at FROM public.transactions WHERE id = p_transaction_id) IS NOT NULL THEN
        RAISE EXCEPTION 'transacao % ja foi excluida', p_transaction_id;
    END IF;

    SELECT profile_id, direction, status
      INTO v_cat_profile, v_cat_direction, v_cat_status
      FROM public.categories WHERE id = p_category_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'categoria % nao encontrada', p_category_id;
    END IF;
    IF v_cat_profile <> p_profile_id THEN
        RAISE EXCEPTION 'categoria % pertence a outro perfil', p_category_id;
    END IF;
    IF v_cat_status <> 'active' THEN
        RAISE EXCEPTION 'categoria % nao esta ativa', p_category_id;
    END IF;

    IF v_tx_kind = 'transfer' THEN
        RAISE EXCEPTION 'transacao de transferencia nao recebe categoria';
    END IF;
    IF v_cat_direction <> v_tx_kind THEN
        RAISE EXCEPTION 'categoria de direcao % incompativel com transacao % (kind %)',
            v_cat_direction, p_transaction_id, v_tx_kind;
    END IF;

    UPDATE public.transactions
       SET category_id    = p_category_id,
           transaction_kind = v_cat_direction,
           updated_at     = now()
     WHERE id = p_transaction_id;

    UPDATE public.reclassification_queue
       SET status = 'closed', closed_at = now()
     WHERE id = (
           SELECT id FROM public.reclassification_queue
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

    INSERT INTO public.category_assignment_audit
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

-- 4) Guard em transaction_get_detail: impedir leitura de transação excluída (SECURITY DEFINER ignora RLS)
CREATE OR REPLACE FUNCTION app.transaction_get_detail(p_transaction_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
    v_tx      jsonb;
    v_link    jsonb;
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;

    SELECT to_jsonb(t) INTO v_tx
      FROM public.transactions t
     WHERE t.id = p_transaction_id AND t.profile_id = v_profile;
    IF v_tx IS NULL THEN
        RAISE EXCEPTION 'transacao % nao encontrada', p_transaction_id;
    END IF;

    IF (v_tx ->> 'deleted_at') IS NOT NULL THEN
        RAISE EXCEPTION 'transacao % ja foi excluida', p_transaction_id;
    END IF;

    SELECT jsonb_build_object(
        'link_id',               l.id,
        'out_transaction_id',    l.out_transaction_id,
        'in_transaction_id',     l.in_transaction_id,
        'out_account_id',        ot.account_id,
        'in_account_id',         it.account_id,
        'out_account_name',      oa.display_name,
        'in_account_name',       ia.display_name,
        'in_transaction_updated_at', it.updated_at
    ) INTO v_link
      FROM public.transfer_links l
      LEFT JOIN public.transactions ot ON ot.id = l.out_transaction_id
      LEFT JOIN public.transactions it ON it.id = l.in_transaction_id
      LEFT JOIN public.accounts oa ON oa.id = ot.account_id
      LEFT JOIN public.accounts ia ON ia.id = it.account_id
     WHERE (l.out_transaction_id = p_transaction_id OR l.in_transaction_id = p_transaction_id)
       AND (l.deleted_at IS NULL);
    RETURN jsonb_build_object('transaction', v_tx, 'transfer', v_link);
END;
$$;

-- 5) RPC transaction_delete (core)
CREATE OR REPLACE FUNCTION app.transaction_delete(
    p_transaction_id      uuid,
    p_expected_updated_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_cur          public.transactions%ROWTYPE;
    v_profile      uuid;
    v_audit_id     uuid;
    v_is_transfer  boolean := false;
    v_other_id     uuid;
    v_link_id      uuid;
    v_now          timestamptz := now();
BEGIN
    SELECT * INTO v_cur
      FROM public.transactions WHERE id = p_transaction_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'transacao % nao encontrada', p_transaction_id;
    END IF;

    v_profile := app.jwt_profile_id();
    IF v_cur.profile_id <> v_profile THEN
        RAISE EXCEPTION 'perfil do token nao possui a transacao %', p_transaction_id;
    END IF;

    IF v_cur.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'transacao % ja foi excluida', p_transaction_id;
    END IF;

    IF p_expected_updated_at IS NULL THEN
        RAISE EXCEPTION 'expected_updated obrigatorio para exclusao';
    END IF;
    IF abs(extract(epoch FROM (v_cur.updated_at - p_expected_updated_at))) > 0.001 THEN
        RAISE EXCEPTION 'CONFLITO: transacao foi modificada por outra operacao';
    END IF;

    SELECT tl.id,
           CASE WHEN tl.out_transaction_id = p_transaction_id THEN tl.in_transaction_id ELSE tl.out_transaction_id END
      INTO v_link_id, v_other_id
      FROM public.transfer_links tl
     WHERE tl.out_transaction_id = p_transaction_id
        OR tl.in_transaction_id  = p_transaction_id
     LIMIT 1;

    v_is_transfer := v_link_id IS NOT NULL;

    PERFORM app.close_all_open_queue(p_transaction_id);

    INSERT INTO public.transaction_audit
        (id, transaction_id, related_transaction_id, transfer_link_id,
         action, before_state, after_state, changed_by, created_at)
    VALUES (
        gen_random_uuid(),
        p_transaction_id,
        CASE WHEN v_is_transfer THEN v_other_id ELSE NULL END,
        CASE WHEN v_is_transfer THEN v_link_id  ELSE NULL END,
        'delete',
        to_jsonb(v_cur.*),
        jsonb_build_object('deleted_at', v_now),
        v_profile,
        v_now
    )
    RETURNING id INTO v_audit_id;

    UPDATE public.transactions SET deleted_at = v_now, updated_at = v_now
     WHERE id = p_transaction_id;

    IF v_is_transfer THEN
        UPDATE public.transactions SET deleted_at = v_now, updated_at = v_now
         WHERE id = v_other_id;

        UPDATE public.transfer_links SET deleted_at = v_now
         WHERE id = v_link_id;

        PERFORM app.close_all_open_queue(v_other_id);
    END IF;

    RETURN jsonb_build_object(
        'transaction_id', p_transaction_id,
        'deleted_at',     v_now,
        'audit_id',       v_audit_id,
        'transfer',       v_is_transfer
    );
END;
$$;

GRANT EXECUTE ON FUNCTION app.transaction_delete(uuid, timestamptz) TO authenticated;

-- 5) Wrapper público (SECURITY INVOKER — mesmo padrão do 012)
CREATE OR REPLACE FUNCTION public.transaction_delete(
    p_transaction_id      uuid,
    p_expected_updated_at timestamptz
) RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, app
AS $$
    SELECT app.transaction_delete(p_transaction_id, p_expected_updated_at);
$$;

GRANT EXECUTE ON FUNCTION public.transaction_delete(uuid, timestamptz) TO authenticated;

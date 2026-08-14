-- 011_transaction_crud_atomic.sql
-- Escrita atomica e segura de transacoes (criacao e edicao) via RPCs.
--
-- Decisoes (auditoria do schema real da fase 4B):
--   * transactions.id/profile_id/import_batch_id/external_record_id/category_raw/
--     created_at/updated_at sao tecnicos e nao editaveis pelo usuario;
--   * editaveis: transaction_kind, amount, occurred_on, raw_description,
--     normalized_description (derivada da descricao), account_id, category_id,
--     status, memo;
--   * transferencia e representada por DUAS transacoes (saida/entrada) +
--     transfer_links; nunca como uma despesa unica;
--   * o perfil vem SEMPRE do JWT (app.jwt_profile_id()), nunca do payload;
--   * conta valida = existe account_profile_periods cobrindo a data no perfil;
--   * categoria ativa, do mesmo perfil e com direction == kind; transferencia
--     nao recebe categoria (nao existem categorias direction='transfer' no schema);
--   * bloqueio otimista por updated_at com tolerancia de 1ms (pglite devolve
--     timestamptz como Date de precisao de milissegundos);
--   * ao sair do status 'review' todos os itens abertos da fila sao fechados
--     (historico preservado em reclassification_queue.status = 'closed').
--
-- Nenhum INSERT/UPDATE direto e liberado ao authenticated: as RLS de escrita
-- continuam exclusivas de service_role; a gravacao ocorre exclusivamente dentro
-- das funcoes SECURITY DEFINER abaixo.

BEGIN;

-- ---------- Trilha de auditoria de criacao/edicao ----------
-- category_assignment_audit nao comporta estado anterior/posterior de uma
-- edicao completa (so tem from/to de categoria), por isso uma tabela propria.
CREATE TABLE transaction_audit (
    id                     uuid PRIMARY KEY,
    transaction_id         uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    action                 text NOT NULL CHECK (action IN ('create', 'update')),
    before_state           jsonb,
    after_state            jsonb NOT NULL,
    changed_by             uuid,
    transfer_link_id       uuid REFERENCES transfer_links (id) ON DELETE SET NULL,
    related_transaction_id uuid REFERENCES transactions (id) ON DELETE CASCADE,
    created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ta_transaction ON transaction_audit (transaction_id);
CREATE INDEX IF NOT EXISTS idx_ta_link        ON transaction_audit (transfer_link_id);
CREATE INDEX IF NOT EXISTS idx_ta_related     ON transaction_audit (related_transaction_id);

ALTER TABLE transaction_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY ta_select_own ON transaction_audit FOR SELECT
    USING (app.jwt_role() = 'service_role'
           OR EXISTS (SELECT 1 FROM transactions t
                      WHERE t.id = transaction_audit.transaction_id
                        AND t.profile_id = app.jwt_profile_id()));

CREATE POLICY ta_write_service ON transaction_audit FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

GRANT SELECT ON transaction_audit TO authenticated;

-- ---------- Normalizacao de descricao (padrao dos seeds: minuscula + sem acento) ----------
CREATE OR REPLACE FUNCTION app.normalize_description(p_text text) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, app
AS $$
    SELECT trim(lower(translate(
        p_text,
        'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖòóôõöÙÚÛÜùúûüÇçÑñÝý',
        'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNnYy'
    )));
$$;

-- ---------- Estado jsonb de uma transacao (auditoria) ----------
CREATE OR REPLACE FUNCTION app.tx_state_jsonb(p_id uuid) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, app
AS $$
    SELECT to_jsonb(t) FROM transactions t WHERE t.id = p_id;
$$;

-- ---------- Validacao de conta (perfil + data via account_profile_periods) ----------
CREATE OR REPLACE FUNCTION app.assert_account_for_profile(
    p_account_id  uuid,
    p_profile     uuid,
    p_occurred_on date
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_valid boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM account_profile_periods pp
         WHERE pp.account_id = p_account_id
           AND pp.profile_id  = p_profile
           AND pp.starts_on  <= p_occurred_on
           AND (pp.ends_on IS NULL OR pp.ends_on >= p_occurred_on)
    ) INTO v_valid;
    IF NOT v_valid THEN
        RAISE EXCEPTION 'conta % nao e valida para o perfil na data %', p_account_id, p_occurred_on;
    END IF;
END;
$$;

-- ---------- Validacao de categoria (perfil + ativa + direcao) ----------
CREATE OR REPLACE FUNCTION app.resolve_category_for_profile(
    p_category_id uuid,
    p_kind        text,
    p_profile     uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_id uuid;
BEGIN
    IF p_category_id IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT c.id INTO v_id
      FROM categories c
     WHERE c.id = p_category_id
       AND c.profile_id = p_profile
       AND c.status = 'active'
       AND c.direction = p_kind;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'categoria % incompativel, inativa ou de outro perfil', p_category_id;
    END IF;
    RETURN v_id;
END;
$$;

-- ---------- Fechamento de fila (item prioritario) + auditoria de categoria ----------
CREATE OR REPLACE FUNCTION app.close_queue_item(
    p_transaction_id uuid,
    p_from_category  uuid,
    p_to_category    uuid,
    p_by             uuid,
    p_reason         text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_q uuid;
BEGIN
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
     RETURNING id INTO v_q;
    IF v_q IS NOT NULL AND p_to_category IS NOT NULL THEN
        INSERT INTO category_assignment_audit
            (id, transaction_id, queue_item_id, from_category_id, to_category_id,
             assigned_by, reason, created_at)
        VALUES
            (gen_random_uuid(), p_transaction_id, v_q, p_from_category, p_to_category,
             p_by, p_reason, now());
    END IF;
    RETURN v_q;
END;
$$;

-- ---------- Fechamento completo da fila (saida do status review) ----------
CREATE OR REPLACE FUNCTION app.close_all_open_queue(p_transaction_id uuid) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_n integer;
BEGIN
    UPDATE reclassification_queue
       SET status = 'closed', closed_at = now()
     WHERE transaction_id = p_transaction_id AND status = 'open';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;

-- ---------- CRIACAO ----------
CREATE OR REPLACE FUNCTION app.transaction_create(
    p_kind           text,
    p_description    text,
    p_amount         numeric,
    p_occurred_on    date,
    p_account_id     uuid,
    p_to_account_id  uuid DEFAULT NULL,
    p_category_id    uuid DEFAULT NULL,
    p_status         text DEFAULT 'posted',
    p_memo           text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile   uuid;
    v_sub       uuid;
    v_norm      text;
    v_out_id    uuid;
    v_in_id     uuid;
    v_link_id   uuid;
    v_category  uuid;
BEGIN
    v_profile := app.jwt_profile_id();
    v_sub     := app.jwt_sub();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;

    IF p_description IS NULL OR trim(p_description) = '' THEN
        RAISE EXCEPTION 'descricao obrigatoria';
    END IF;
    v_norm := app.normalize_description(p_description);

    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'valor deve ser positivo';
    END IF;
    IF p_occurred_on IS NULL THEN
        RAISE EXCEPTION 'data obrigatoria';
    END IF;
    IF p_status IS NULL OR p_status NOT IN ('posted','pending','review','scheduled','ignored') THEN
        RAISE EXCEPTION 'status invalido: %', p_status;
    END IF;

    IF p_kind = 'transfer' THEN
        IF p_category_id IS NOT NULL THEN
            RAISE EXCEPTION 'transferencia nao recebe categoria';
        END IF;
        IF p_to_account_id IS NULL THEN
            RAISE EXCEPTION 'conta de destino obrigatoria na transferencia';
        END IF;
        IF p_to_account_id = p_account_id THEN
            RAISE EXCEPTION 'conta de origem e destino devem ser diferentes';
        END IF;
        PERFORM app.assert_account_for_profile(p_account_id,    v_profile, p_occurred_on);
        PERFORM app.assert_account_for_profile(p_to_account_id, v_profile, p_occurred_on);

        v_out_id := gen_random_uuid();
        v_in_id  := gen_random_uuid();
        INSERT INTO transactions
            (id, profile_id, account_id, category_id, transaction_kind, amount, occurred_on,
             raw_description, normalized_description, memo, status, updated_at)
        VALUES
            (v_out_id, v_profile, p_account_id, NULL, 'transfer', p_amount, p_occurred_on,
             trim(p_description), v_norm, p_memo, p_status, now());
        INSERT INTO transactions
            (id, profile_id, account_id, category_id, transaction_kind, amount, occurred_on,
             raw_description, normalized_description, memo, status, updated_at)
        VALUES
            (v_in_id, v_profile, p_to_account_id, NULL, 'transfer', p_amount, p_occurred_on,
             trim(p_description), v_norm, p_memo, p_status, now());
        INSERT INTO transfer_links (id, out_transaction_id, in_transaction_id)
        VALUES (gen_random_uuid(), v_out_id, v_in_id)
        RETURNING id INTO v_link_id;

        INSERT INTO transaction_audit
            (id, transaction_id, action, before_state, after_state, changed_by,
             transfer_link_id, related_transaction_id)
        VALUES
            (gen_random_uuid(), v_out_id, 'create', NULL, app.tx_state_jsonb(v_out_id), v_sub,
             v_link_id, v_in_id);
        INSERT INTO transaction_audit
            (id, transaction_id, action, before_state, after_state, changed_by,
             transfer_link_id, related_transaction_id)
        VALUES
            (gen_random_uuid(), v_in_id, 'create', NULL, app.tx_state_jsonb(v_in_id), v_sub,
             v_link_id, v_out_id);

        RETURN jsonb_build_object(
            'transaction_id',     v_out_id,
            'out_transaction_id', v_out_id,
            'in_transaction_id',  v_in_id,
            'transfer_link_id',   v_link_id
        );
    END IF;

    IF p_kind NOT IN ('income', 'expense') THEN
        RAISE EXCEPTION 'tipo invalido: % (esperado income, expense ou transfer)', p_kind;
    END IF;

    PERFORM app.assert_account_for_profile(p_account_id, v_profile, p_occurred_on);
    v_category := app.resolve_category_for_profile(p_category_id, p_kind, v_profile);

    v_out_id := gen_random_uuid();
    INSERT INTO transactions
        (id, profile_id, account_id, category_id, transaction_kind, amount, occurred_on,
         raw_description, normalized_description, memo, status, updated_at)
    VALUES
        (v_out_id, v_profile, p_account_id, v_category, p_kind, p_amount, p_occurred_on,
         trim(p_description), v_norm, p_memo, p_status, now());

    INSERT INTO transaction_audit
        (id, transaction_id, action, before_state, after_state, changed_by,
         transfer_link_id, related_transaction_id)
    VALUES
        (gen_random_uuid(), v_out_id, 'create', NULL, app.tx_state_jsonb(v_out_id), v_sub,
         NULL, NULL);

    RETURN jsonb_build_object(
        'transaction_id', v_out_id,
        'out_transaction_id', v_out_id,
        'in_transaction_id', NULL,
        'transfer_link_id', NULL
    );
END;
$$;

-- ---------- EDICAO ----------
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
    v_profile    uuid;
    v_sub        uuid;
    v_cur        record;
    v_link       record;
    v_norm       text;
    v_category   uuid;
    v_was_review boolean;
    v_old_state  jsonb;
    v_out        uuid;
    v_in         uuid;
    v_link_id    uuid;
    v_out_old    jsonb;
    v_in_old     jsonb;
    v_out_new    jsonb;
    v_in_new     jsonb;
BEGIN
    v_profile := app.jwt_profile_id();
    v_sub     := app.jwt_sub();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;

    SELECT * INTO v_cur
      FROM transactions
     WHERE id = p_transaction_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'transacao % nao encontrada', p_transaction_id;
    END IF;
    IF v_cur.profile_id <> v_profile THEN
        RAISE EXCEPTION 'perfil do token nao possui a transacao %', p_transaction_id;
    END IF;

    IF abs(extract(epoch FROM (v_cur.updated_at - p_expected_updated_at))) > 0.001 THEN
        RAISE EXCEPTION 'CONFLITO: transacao foi modificada por outra operacao (updated_at divergente)';
    END IF;

    IF p_description IS NULL OR trim(p_description) = '' THEN
        RAISE EXCEPTION 'descricao obrigatoria';
    END IF;
    v_norm := app.normalize_description(p_description);

    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'valor deve ser positivo';
    END IF;
    IF p_occurred_on IS NULL THEN
        RAISE EXCEPTION 'data obrigatoria';
    END IF;
    IF p_status IS NULL OR p_status NOT IN ('posted','pending','review','scheduled','ignored') THEN
        RAISE EXCEPTION 'status invalido: %', p_status;
    END IF;

    v_was_review := (v_cur.status = 'review');
    v_old_state  := app.tx_state_jsonb(p_transaction_id);

    SELECT * INTO v_link
      FROM transfer_links
     WHERE out_transaction_id = p_transaction_id
        OR in_transaction_id  = p_transaction_id
     FOR UPDATE;

    v_out     := NULL;
    v_in      := NULL;
    v_link_id := NULL;
    IF v_link.id IS NOT NULL THEN
        v_link_id := v_link.id;
        v_out     := v_link.out_transaction_id;
        v_in      := v_link.in_transaction_id;
        PERFORM 1 FROM transactions WHERE id IN (v_out, v_in) FOR UPDATE;
    END IF;

    IF p_kind = 'transfer' THEN
        IF p_category_id IS NOT NULL THEN
            RAISE EXCEPTION 'transferencia nao recebe categoria';
        END IF;
        IF p_to_account_id IS NULL THEN
            RAISE EXCEPTION 'conta de destino obrigatoria na transferencia';
        END IF;
        IF p_to_account_id = p_account_id THEN
            RAISE EXCEPTION 'conta de origem e destino devem ser diferentes';
        END IF;
        PERFORM app.assert_account_for_profile(p_account_id,    v_profile, p_occurred_on);
        PERFORM app.assert_account_for_profile(p_to_account_id, v_profile, p_occurred_on);

        IF v_link_id IS NULL AND p_to_account_id IS DISTINCT FROM v_cur.account_id THEN
            -- transferencia legada sem vinculo: promove a linha atual a ponta de saida
            -- e cria a ponta de entrada + transfer_links, de forma atomica.
            v_out := p_transaction_id;
            v_in  := gen_random_uuid();
            INSERT INTO transactions
                (id, profile_id, account_id, category_id, transaction_kind, amount, occurred_on,
                 raw_description, normalized_description, memo, status, updated_at)
            VALUES
                (v_in, v_profile, p_to_account_id, NULL, 'transfer', p_amount, p_occurred_on,
                 trim(p_description), v_norm, p_memo, p_status, now());
            INSERT INTO transfer_links (id, out_transaction_id, in_transaction_id)
            VALUES (gen_random_uuid(), v_out, v_in)
            RETURNING id INTO v_link_id;
        END IF;

        IF v_in IS NOT NULL THEN
            -- par (novo ou existente): atualiza as duas pontas pelo papel
            v_out_old := app.tx_state_jsonb(v_out);
            v_in_old  := app.tx_state_jsonb(v_in);
            UPDATE transactions
               SET account_id = p_account_id, amount = p_amount,
                   occurred_on = p_occurred_on, raw_description = trim(p_description),
                   normalized_description = v_norm, memo = p_memo, status = p_status,
                   updated_at = now()
             WHERE id = v_out;
            UPDATE transactions
               SET account_id = p_to_account_id, amount = p_amount,
                   occurred_on = p_occurred_on, raw_description = trim(p_description),
                   normalized_description = v_norm, memo = p_memo, status = p_status,
                   updated_at = now()
             WHERE id = v_in;
            v_out_new := app.tx_state_jsonb(v_out);
            v_in_new  := app.tx_state_jsonb(v_in);

            INSERT INTO transaction_audit
                (id, transaction_id, action, before_state, after_state, changed_by,
                 transfer_link_id, related_transaction_id)
            VALUES
                (gen_random_uuid(), v_out, 'update', v_out_old, v_out_new, v_sub, v_link_id, v_in);
            INSERT INTO transaction_audit
                (id, transaction_id, action, before_state, after_state, changed_by,
                 transfer_link_id, related_transaction_id)
            VALUES
                (gen_random_uuid(), v_in, 'update', v_in_old, v_in_new, v_sub, v_link_id, v_out);

            IF v_was_review AND p_status <> 'review' THEN
                PERFORM app.close_all_open_queue(v_out);
                PERFORM app.close_all_open_queue(v_in);
            END IF;

            RETURN jsonb_build_object(
                'transaction_id', p_transaction_id,
                'out_transaction_id', v_out,
                'in_transaction_id', v_in,
                'transfer_link_id', v_link_id
            );
        END IF;

        -- legada sem vinculo e sem destino distinto: atualiza apenas a linha
        UPDATE transactions
           SET account_id = p_account_id, amount = p_amount,
               occurred_on = p_occurred_on, raw_description = trim(p_description),
               normalized_description = v_norm, memo = p_memo, status = p_status,
               updated_at = now()
         WHERE id = p_transaction_id;

        INSERT INTO transaction_audit
            (id, transaction_id, action, before_state, after_state, changed_by,
             transfer_link_id, related_transaction_id)
        VALUES
            (gen_random_uuid(), p_transaction_id, 'update', v_old_state,
             app.tx_state_jsonb(p_transaction_id), v_sub, NULL, NULL);

        IF v_was_review AND p_status <> 'review' THEN
            PERFORM app.close_all_open_queue(p_transaction_id);
        END IF;

        RETURN jsonb_build_object(
            'transaction_id', p_transaction_id,
            'out_transaction_id', p_transaction_id,
            'in_transaction_id', NULL,
            'transfer_link_id', NULL
        );
    END IF;

    -- income / expense
    IF p_kind NOT IN ('income', 'expense') THEN
        RAISE EXCEPTION 'tipo invalido: % (esperado income, expense ou transfer)', p_kind;
    END IF;
    PERFORM app.assert_account_for_profile(p_account_id, v_profile, p_occurred_on);
    v_category := app.resolve_category_for_profile(p_category_id, p_kind, v_profile);

    -- dissolve um par de transferencia, se a transacao sair do tipo transfer
    IF v_cur.transaction_kind = 'transfer' AND v_link_id IS NOT NULL THEN
        DELETE FROM transfer_links WHERE id = v_link_id;
        DELETE FROM transactions
         WHERE id = (CASE WHEN v_in = p_transaction_id THEN v_out ELSE v_in END);
    END IF;

    UPDATE transactions
       SET account_id = p_account_id, category_id = v_category,
           transaction_kind = p_kind, amount = p_amount,
           occurred_on = p_occurred_on, raw_description = trim(p_description),
           normalized_description = v_norm, memo = p_memo, status = p_status,
           updated_at = now()
     WHERE id = p_transaction_id;

    IF v_category IS NOT NULL AND v_cur.category_id IS DISTINCT FROM v_category THEN
        PERFORM app.close_queue_item(p_transaction_id, v_cur.category_id, v_category, v_sub, 'transaction_update');
    END IF;
    IF v_was_review AND p_status <> 'review' THEN
        PERFORM app.close_all_open_queue(p_transaction_id);
    END IF;

    INSERT INTO transaction_audit
        (id, transaction_id, action, before_state, after_state, changed_by,
         transfer_link_id, related_transaction_id)
    VALUES
        (gen_random_uuid(), p_transaction_id, 'update', v_old_state,
         app.tx_state_jsonb(p_transaction_id), v_sub, NULL, NULL);

    RETURN jsonb_build_object(
        'transaction_id', p_transaction_id,
        'out_transaction_id', p_transaction_id,
        'in_transaction_id', NULL,
        'transfer_link_id', NULL
    );
END;
$$;

-- ---------- DETALHE (editor: par de transferencia) ----------
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
      FROM transactions t
     WHERE t.id = p_transaction_id AND t.profile_id = v_profile;
    IF v_tx IS NULL THEN
        RAISE EXCEPTION 'transacao % nao encontrada', p_transaction_id;
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
      FROM transfer_links l
      LEFT JOIN transactions ot ON ot.id = l.out_transaction_id
      LEFT JOIN transactions it ON it.id = l.in_transaction_id
      LEFT JOIN accounts oa ON oa.id = ot.account_id
      LEFT JOIN accounts ia ON ia.id = it.account_id
     WHERE l.out_transaction_id = p_transaction_id
        OR l.in_transaction_id  = p_transaction_id;
    RETURN jsonb_build_object('transaction', v_tx, 'transfer', v_link);
END;
$$;

-- ---------- Privilegios ----------
REVOKE EXECUTE ON FUNCTION app.normalize_description(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.tx_state_jsonb(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.assert_account_for_profile(uuid, uuid, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.resolve_category_for_profile(uuid, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.close_queue_item(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.close_all_open_queue(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.transaction_create(text, text, numeric, date, uuid, uuid, uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.transaction_update(uuid, timestamptz, text, text, numeric, date, uuid, uuid, uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.transaction_get_detail(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.normalize_description(text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.tx_state_jsonb(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.assert_account_for_profile(uuid, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION app.resolve_category_for_profile(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.close_queue_item(uuid, uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.close_all_open_queue(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.transaction_create(text, text, numeric, date, uuid, uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.transaction_update(uuid, timestamptz, text, text, numeric, date, uuid, uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.transaction_get_detail(uuid) TO authenticated;

COMMIT;

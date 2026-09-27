-- 027_series_scope_actions.sql
-- PESSOAL-13C4A-E10B — Edição e exclusão de séries por escopo.
--
-- IDEMPOTENTE e AUTOCONTIDA. NÃO é aplicado por esta tarefa.
-- Estado de partida = catálogo real capturado no V6 (blocos B02/B03/B04/B05),
-- NÃO o texto da migration 023 (inexistente no repositório e irrecuperável
-- pelo Postgres). Nenhum INSERT em schema_migrations.
--
-- Contrato dos três escopos:
--   'this'          -> somente a ocorrência p_from_occurrence
--   'this_and_next' -> ocorrências com occurrence_index >= p_from_occurrence
--   'whole'         -> todas as ocorrências da série
--
-- Regras fechadas implementadas aqui:
--   1. Status NÃO é propagado em escopo coletivo. p_status só é aceito em
--      'this'; nos demais o backend REJEITA (não ignora em silêncio).
--   2. is_edited NUNCA é pulado em silêncio. Ocorrências editadas
--      individualmente são INCLUÍDAS no escopo e contadas; exigem confirmação.
--   3. before_state é capturado ANTES de qualquer UPDATE/soft-delete.
--   4. Concorrência otimista em TODOS os escopos, contra transaction_series.
--      updated_at (toda operação mutante faz bump nessa coluna).
--   5. Impacto/contagens exatas + prévia dedicada (app.series_scope_impact).
--   6. 'preserve' vs 'clear' explícitos para category_id e memo via *_action
--      ('preserve'|'set'|'clear'); NULL deixa de ter significado ambíguo.
--   7. anon/PUBLIC sem EXECUTE nos RPCs mutáveis; só authenticated.
--
-- Campos editáveis: descrição, valor, conta, categoria, observação.
-- NÃO editáveis em lote (e nunca tocados): occurred_on, frequency,
-- total_occurrences, occurrence_index, direction, transaction_kind.
-- Exclusão é SEMPRE soft delete (transactions.deleted_at); nunca há hard delete.
-- Parcelamento: valor em escopo COLETIVO é bloqueado com mensagem explícita
-- (o schema não representa com segurança redistribuir parcelas já materializadas
-- e pagas mantendo a soma); em 'this' o valor permanece permitido.

-- ============================================================================
-- 0) Precondições: o estado real capturado precisa existir.
-- ============================================================================
DO $$
BEGIN
    IF to_regclass('public.transaction_series') IS NULL
       OR to_regclass('public.transaction_series_occurrences') IS NULL THEN
        RAISE EXCEPTION
            'E10B: tabelas de série ausentes. Estado capturado diverge do esperado; rode o preflight antes.';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'transaction_series_occurrences'
           AND column_name = 'is_edited'
    ) THEN
        RAISE EXCEPTION 'E10B: transaction_series_occurrences.is_edited ausente.';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'transactions'
           AND column_name = 'deleted_at'
    ) THEN
        RAISE EXCEPTION 'E10B: transactions.deleted_at ausente; soft delete indisponível.';
    END IF;
END;
$$;

-- ============================================================================
-- 1) Remoção das assinaturas defeituosas.
--    A assinatura muda (parâmetros de ação/confirmação), então é preciso dropar
--    a anterior: CREATE OR REPLACE não troca aridade.
--
--    IMPORTANTE (PESSOAL-13C4A-E10B): os wrappers public.* são o ÚNICO caminho
--    do app, porque o PostgREST resolve supabase.rpc(...) no schema exposto
--    (public). O catálogo implantado NÃO tem wrappers public.* de série
--    (B03: wrappers_public_dependentes=[]; B12: nenhum objeto public de
--    função), então hoje edição/exclusão de recorrência pela UI está quebrada.
--    Este drop é defensivo: se o 021 tiver sido aplicado em algum ambiente,
--    remove a aridade antiga antes de recriar com a nova.
-- ============================================================================
DROP FUNCTION IF EXISTS public.transaction_series_delete(uuid, integer, text, timestamptz, boolean);
DROP FUNCTION IF EXISTS public.transaction_series_edit(uuid, integer, text, timestamptz, text, numeric, uuid, uuid, text, text, boolean);
DROP FUNCTION IF EXISTS public.transaction_series_preview(text, text, text, numeric, integer, date, uuid, uuid);

DROP FUNCTION IF EXISTS app.transaction_series_delete(uuid, integer, text, timestamptz, boolean);
DROP FUNCTION IF EXISTS app.transaction_series_edit(uuid, integer, text, timestamptz, text, numeric, uuid, uuid, text, text, boolean);
DROP FUNCTION IF EXISTS app.series_scope_impact(uuid, integer, text);

-- ============================================================================
-- 2) PRÉVIA DE IMPACTO (read-only). Fonte única de verdade da contagem.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.series_scope_impact(
    p_series_id       uuid,
    p_from_occurrence integer DEFAULT NULL,
    p_scope           text    DEFAULT 'whole'
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'app'
AS $function$
DECLARE
    v_profile uuid;
    v_ser     record;
    v_found   boolean;
    v_total   integer := 0;
    v_ativas  integer := 0;
    v_excl    integer := 0;
    v_pass    integer := 0;
    v_fut     integer := 0;
    v_posted  integer := 0;
    v_pending integer := 0;
    v_sched   integer := 0;
    v_edit    integer := 0;
    v_dmin    date;
    v_dmax    date;
    v_idx_edit integer[] := '{}';
    v_idx_excl integer[] := '{}';
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    IF p_scope NOT IN ('this', 'this_and_next', 'whole') THEN
        RAISE EXCEPTION 'escopo invalido';
    END IF;
    IF p_scope <> 'whole' AND p_from_occurrence IS NULL THEN
        RAISE EXCEPTION 'ocorrencia de partida obrigatoria';
    END IF;

    SELECT * INTO v_ser FROM transaction_series s
     WHERE s.id = p_series_id AND s.profile_id = v_profile;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'serie nao encontrada neste perfil';
    END IF;

    -- ocorrência de partida precisa existir e ser deste perfil
    v_found := false;
    IF p_scope <> 'whole' THEN
        SELECT true INTO v_found
          FROM transaction_series_occurrences o
          JOIN transactions t ON t.id = o.transaction_id
         WHERE o.series_id = v_ser.id
           AND o.occurrence_index = p_from_occurrence
           AND t.profile_id = v_profile;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'ocorrencia de partida nao encontrada';
        END IF;
    END IF;

    SELECT
        count(*)                                                          AS v_total,
        count(*) FILTER (WHERE t.deleted_at IS NULL)                      AS v_ativas,
        count(*) FILTER (WHERE t.deleted_at IS NOT NULL)                  AS v_excl,
        count(*) FILTER (WHERE t.deleted_at IS NULL AND o.occurred_on <  current_date) AS v_pass,
        count(*) FILTER (WHERE t.deleted_at IS NULL AND o.occurred_on >= current_date) AS v_fut,
        count(*) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'posted')    AS v_posted,
        count(*) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'pending')   AS v_pending,
        count(*) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'scheduled') AS v_sched,
        count(*) FILTER (WHERE t.deleted_at IS NULL AND o.is_edited)      AS v_edit,
        min(o.occurred_on)                                                AS v_dmin,
        max(o.occurred_on)                                                AS v_dmax,
        coalesce(array_agg(o.occurrence_index ORDER BY o.occurrence_index)
                 FILTER (WHERE o.is_edited), '{}')                        AS v_idx_edit,
        coalesce(array_agg(o.occurrence_index ORDER BY o.occurrence_index)
                 FILTER (WHERE t.deleted_at IS NOT NULL), '{}')           AS v_idx_excl
      INTO v_total, v_ativas, v_excl, v_pass, v_fut,
           v_posted, v_pending, v_sched, v_edit,
           v_dmin, v_dmax, v_idx_edit, v_idx_excl
      FROM transaction_series_occurrences o
      JOIN transactions t ON t.id = o.transaction_id
     WHERE o.series_id = v_ser.id
       AND (   p_scope = 'whole'
            OR (p_scope = 'this'           AND o.occurrence_index = p_from_occurrence)
            OR (p_scope = 'this_and_next'  AND o.occurrence_index >= p_from_occurrence));

    RETURN jsonb_build_object(
        'series_id',            v_ser.id,
        'kind',                 v_ser.kind,
        'scope',                p_scope,
        'from_occurrence',      p_from_occurrence,
        'ocorrencia_partida_encontrada', v_found,
        'total_no_escopo',      v_total,
        'ativas',               v_ativas,
        'ja_excluidas',         v_excl,
        'passadas',             v_pass,
        'futuras',              v_fut,
        'pagas',                v_posted,
        'posted',               v_posted,
        'pending',              v_pending,
        'scheduled',            v_sched,
        'editadas',             v_edit,
        'indices_editados',     to_jsonb(v_idx_edit),
        'indices_ja_excluidos', to_jsonb(v_idx_excl),
        'primeira_data',        v_dmin,
        'ultima_data',          v_dmax,
        -- confirmações exigidas antes de atingir passado / pago / editada
        'requer_confirmacao_passado', (v_pass > 0),
        'requer_confirmacao_pago',    (v_posted > 0),
        'requer_confirmacao_editada', (v_edit > 0),
        -- contrato de valor: installment não redistribui em lote
        'valor_coletivo_bloqueado', (v_ser.kind = 'installment' AND p_scope <> 'this'),
        -- contrato de status: nunca propagado em escopo coletivo
        'status_propagado',     false
    );
END;
$function$;

COMMENT ON FUNCTION app.series_scope_impact(uuid, integer, text) IS
    'E10B: previa de impacto (somente leitura) por escopo. Retorna contagens exatas de ativas/passadas/pagas/pending/scheduled/editadas/ja_excluidas, primeira e ultima data, e quais confirmacoes sao exigidas.';

-- ============================================================================
-- 3) EXCLUSÃO por escopo. Soft delete apenas. Sem skip de is_edited.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.transaction_series_delete(
    p_series_id           uuid,
    p_from_occurrence     integer     DEFAULT NULL,
    p_scope               text        DEFAULT 'whole',
    p_expected_updated_at timestamptz DEFAULT NULL,
    p_confirm_past        boolean     DEFAULT false,
    p_confirm_posted      boolean     DEFAULT false,
    p_confirm_edited      boolean     DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'app'
AS $function$
DECLARE
    v_profile  uuid;
    v_sub      uuid;
    v_ser      record;
    v_oc       record;
    v_impact   jsonb;
    v_deleted  integer := 0;
    v_edited   integer := 0;
    v_before   jsonb;
    v_after    jsonb;
    v_total    integer := 0;
    v_excl     integer := 0;
    v_pass     integer := 0;
    v_posted   integer := 0;
    v_edit     integer := 0;
BEGIN
    v_profile := app.jwt_profile_id();
    v_sub     := app.jwt_sub();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    IF p_scope NOT IN ('this', 'this_and_next', 'whole') THEN
        RAISE EXCEPTION 'escopo invalido';
    END IF;
    IF p_scope <> 'whole' AND p_from_occurrence IS NULL THEN
        RAISE EXCEPTION 'ocorrencia de partida obrigatoria';
    END IF;

    -- lock de linha: serializa operações concorrentes sobre a MESMA série
    SELECT * INTO v_ser FROM transaction_series s
     WHERE s.id = p_series_id AND s.profile_id = v_profile
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'serie nao encontrada neste perfil';
    END IF;

    -- (4) concorrência otimista em TODOS os escopos, inclusive 'whole'
    IF p_expected_updated_at IS NOT NULL
       AND abs(extract(epoch FROM (v_ser.updated_at - p_expected_updated_at))) > 0.001 THEN
        RAISE EXCEPTION 'CONFLITO: serie foi modificada por outra operacao'
            USING ERRCODE = '40001';
    END IF;

    -- (5) impacto calculado ANTES de mutar, com a mesma semântica de escopo
    v_impact := app.series_scope_impact(p_series_id, p_from_occurrence, p_scope);
    IF NOT coalesce((v_impact->>'ocorrencia_partida_encontrada')::boolean, true) THEN
        RAISE EXCEPTION 'ocorrencia de partida nao encontrada';
    END IF;
    v_total  := (v_impact->>'total_no_escopo')::integer;
    v_excl   := (v_impact->>'ja_excluidas')::integer;
    v_pass   := (v_impact->>'passadas')::integer;
    v_posted := (v_impact->>'pagas')::integer;
    v_edit   := (v_impact->>'editadas')::integer;

    -- confirmações explícitas: nada é pulado em silêncio
    IF v_pass > 0 AND NOT p_confirm_past THEN
        RAISE EXCEPTION
            'a operacao alcanca % ocorrencia(s) PASSADA(S); confirme com confirm_past=true', v_pass
            USING ERRCODE = 'P0001';
    END IF;
    IF v_posted > 0 AND NOT p_confirm_posted THEN
        RAISE EXCEPTION
            'a operacao alcanca % ocorrencia(s) com status posted; confirme com confirm_posted=true', v_posted
            USING ERRCODE = 'P0001';
    END IF;
    IF v_edit > 0 AND NOT p_confirm_edited THEN
        RAISE EXCEPTION
            'a operacao alcanca % ocorrencia(s) editada(s) individualmente; confirme com confirm_edited=true', v_edit
            USING ERRCODE = 'P0001';
    END IF;

    -- soft delete; is_edited NÃO é pulado: entra no conjunto e é contabilizado
    FOR v_oc IN
        SELECT o.id, o.transaction_id, o.occurrence_index, o.is_edited
          FROM transaction_series_occurrences o
          JOIN transactions t ON t.id = o.transaction_id
         WHERE o.series_id = v_ser.id
           AND t.profile_id = v_profile
           AND t.deleted_at IS NULL
           AND (   p_scope = 'whole'
                OR (p_scope = 'this'          AND o.occurrence_index = p_from_occurrence)
                OR (p_scope = 'this_and_next' AND o.occurrence_index >= p_from_occurrence))
         ORDER BY o.occurrence_index
    LOOP
        IF v_oc.is_edited THEN
            v_edited := v_edited + 1;
        END IF;

        -- (3) before_state ANTES da mutação
        SELECT app.tx_state_jsonb(v_oc.transaction_id) INTO v_before;

        UPDATE transactions
           SET deleted_at = now(), updated_at = now()
         WHERE id = v_oc.transaction_id
           AND deleted_at IS NULL;

        IF FOUND THEN
            SELECT app.tx_state_jsonb(v_oc.transaction_id) INTO v_after;
            INSERT INTO transaction_audit
                (id, transaction_id, action, before_state, after_state, changed_by)
            VALUES
                (gen_random_uuid(), v_oc.transaction_id, 'delete', v_before, v_after, v_sub);
            v_deleted := v_deleted + 1;
        END IF;
    END LOOP;

    -- ciclo de vida da série (idêntico ao 021) + bump de updated_at
    IF p_scope = 'this' THEN
        UPDATE transaction_series SET updated_at = now() WHERE id = v_ser.id;
    ELSIF p_scope = 'this_and_next' THEN
        UPDATE transaction_series
           SET end_occurrence = CASE WHEN p_from_occurrence = 1 THEN 0
                                     ELSE p_from_occurrence - 1 END,
               state = CASE WHEN p_from_occurrence = 1 THEN 'stopped' ELSE 'active' END,
               materialized_through = LEAST(materialized_through,
                                             CASE WHEN p_from_occurrence = 1 THEN 0
                                                  ELSE p_from_occurrence - 1 END),
               updated_at = now()
         WHERE id = v_ser.id;
    ELSE
        UPDATE transaction_series
           SET state = 'stopped', end_occurrence = 0, updated_at = now()
         WHERE id = v_ser.id;
    END IF;

    RETURN jsonb_build_object(
        'series_id',        v_ser.id,
        'scope',            p_scope,
        'afetadas',         v_total,
        'excluidas',        v_deleted,
        'ja_excluidas',     v_excl,
        'passadas',         v_pass,
        'pagas',            v_posted,
        'editadas_atingidas', v_edit,
        'conflitos',        0,
        'impacto',          v_impact,
        'state',            (SELECT state FROM transaction_series WHERE id = v_ser.id)
    );
END;
$function$;

COMMENT ON FUNCTION app.transaction_series_delete(uuid, integer, text, timestamptz, boolean, boolean, boolean) IS
    'E10B: exclusao por escopo (this|this_and_next|whole). Soft delete apenas. Nao pula is_edited em silencio. Exige confirmacao de passado, posted e editada. before_state capturado antes da mutacao. Concorrencia otimista em todos os escopos.';

-- ============================================================================
-- 4) EDIÇÃO por escopo. Sem propagação de status. preserve/set/clear explícito.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.transaction_series_edit(
    p_series_id           uuid,
    p_from_occurrence     integer     DEFAULT NULL,
    p_scope               text        DEFAULT 'whole',
    p_expected_updated_at timestamptz DEFAULT NULL,
    p_display_name        text        DEFAULT NULL,
    p_amount              numeric     DEFAULT NULL,
    p_account_id          uuid        DEFAULT NULL,
    p_category_action     text        DEFAULT 'preserve',
    p_category_id         uuid        DEFAULT NULL,
    p_memo_action         text        DEFAULT 'preserve',
    p_memo                text        DEFAULT NULL,
    p_status              text        DEFAULT NULL,
    p_confirm_past        boolean     DEFAULT false,
    p_confirm_posted      boolean     DEFAULT false,
    p_confirm_edited      boolean     DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'app'
AS $function$
DECLARE
    v_profile uuid;
    v_sub     uuid;
    v_ser     record;
    v_oc      record;
    v_impact  jsonb;
    v_norm    text;
    v_cat     uuid;
    v_before  jsonb;
    v_after   jsonb;
    v_updated integer := 0;
    v_edited  integer := 0;
    v_total   integer := 0;
    v_excl    integer := 0;
    v_pass    integer := 0;
    v_posted  integer := 0;
    v_edit    integer := 0;
BEGIN
    v_profile := app.jwt_profile_id();
    v_sub     := app.jwt_sub();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    IF p_scope NOT IN ('this', 'this_and_next', 'whole') THEN
        RAISE EXCEPTION 'escopo invalido';
    END IF;
    IF p_scope <> 'whole' AND p_from_occurrence IS NULL THEN
        RAISE EXCEPTION 'ocorrencia de partida obrigatoria';
    END IF;

    -- (1) status NUNCA propaga em escopo coletivo: rejeita, não ignora
    IF p_status IS NOT NULL AND p_scope <> 'this' THEN
        RAISE EXCEPTION
            'status so pode ser alterado no escopo ''this''; no escopo ''%'' cada ocorrencia preserva o proprio status', p_scope
            USING ERRCODE = 'P0001';
    END IF;
    IF p_status IS NOT NULL AND p_status NOT IN ('posted', 'pending', 'scheduled') THEN
        RAISE EXCEPTION 'status invalido';
    END IF;

    -- (6) semântica explícita: preserve | set | clear
    IF p_category_action NOT IN ('preserve', 'set', 'clear') THEN
        RAISE EXCEPTION 'acao de categoria invalida (preserve|set|clear)';
    END IF;
    IF p_memo_action NOT IN ('preserve', 'set', 'clear') THEN
        RAISE EXCEPTION 'acao de observacao invalida (preserve|set|clear)';
    END IF;
    IF p_category_action = 'set' AND p_category_id IS NULL THEN
        RAISE EXCEPTION 'acao ''set'' de categoria exige p_category_id';
    END IF;
    IF p_category_action <> 'set' AND p_category_id IS NOT NULL THEN
        RAISE EXCEPTION 'p_category_id exige p_category_action = ''set''';
    END IF;
    IF p_memo_action = 'set' AND p_memo IS NULL THEN
        RAISE EXCEPTION 'acao ''set'' de observacao exige p_memo';
    END IF;
    IF p_memo_action <> 'set' AND p_memo IS NOT NULL THEN
        RAISE EXCEPTION 'p_memo exige p_memo_action = ''set''';
    END IF;

    SELECT * INTO v_ser FROM transaction_series s
     WHERE s.id = p_series_id AND s.profile_id = v_profile
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'serie nao encontrada neste perfil';
    END IF;

    -- (4) concorrência otimista em TODOS os escopos
    IF p_expected_updated_at IS NOT NULL
       AND abs(extract(epoch FROM (v_ser.updated_at - p_expected_updated_at))) > 0.001 THEN
        RAISE EXCEPTION 'CONFLITO: serie foi modificada por outra operacao'
            USING ERRCODE = '40001';
    END IF;

    -- valor: installment não redistribui em lote; 'this' mantém liberado
    IF p_amount IS NOT NULL AND p_scope <> 'this' AND v_ser.kind = 'installment' THEN
        RAISE EXCEPTION
            'parcelamento nao permite alterar valor em lote (%): o valor total nao redistribui com seguranca as parcelas ja materializadas; use o escopo ''this'' para editar o valor de uma ocorrencia', p_scope
            USING ERRCODE = 'P0001';
    END IF;
    IF p_amount IS NOT NULL AND p_amount <= 0 THEN
        RAISE EXCEPTION 'valor deve ser positivo';
    END IF;

    IF p_display_name IS NOT NULL AND trim(p_display_name) = '' THEN
        RAISE EXCEPTION 'descricao obrigatoria';
    END IF;
    IF p_display_name IS NOT NULL THEN
        v_norm := app.normalize_description(p_display_name);
    END IF;
    IF p_account_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM account_profile_periods pp
         WHERE pp.account_id = p_account_id AND pp.profile_id = v_profile
    ) THEN
        RAISE EXCEPTION 'conta nao esta disponivel no perfil';
    END IF;
    IF p_category_action = 'set' THEN
        PERFORM app.resolve_category_for_profile(p_category_id, v_ser.direction, v_profile);
    END IF;

    -- (5) impacto ANTES de mutar
    v_impact := app.series_scope_impact(p_series_id, p_from_occurrence, p_scope);
    v_total  := (v_impact->>'total_no_escopo')::integer;
    v_excl   := (v_impact->>'ja_excluidas')::integer;
    v_pass   := (v_impact->>'passadas')::integer;
    v_posted := (v_impact->>'pagas')::integer;
    v_edit   := (v_impact->>'editadas')::integer;

    IF v_pass > 0 AND NOT p_confirm_past THEN
        RAISE EXCEPTION
            'a operacao alcanca % ocorrencia(s) PASSADA(S); confirme com confirm_past=true', v_pass
            USING ERRCODE = 'P0001';
    END IF;
    IF v_posted > 0 AND NOT p_confirm_posted THEN
        RAISE EXCEPTION
            'a operacao alcanca % ocorrencia(s) com status posted; confirme com confirm_posted=true', v_posted
            USING ERRCODE = 'P0001';
    END IF;
    IF v_edit > 0 AND NOT p_confirm_edited THEN
        RAISE EXCEPTION
            'a operacao alcanca % ocorrencia(s) editada(s) individualmente; confirme com confirm_edited=true', v_edit
            USING ERRCODE = 'P0001';
    END IF;

    -- validação antecipada de TODO o conjunto alvo (atomicidade: nada é gravado
    -- antes; se qualquer ocorrência falhar, nada é gravado)
    FOR v_oc IN
        SELECT o.id, o.transaction_id, o.occurrence_index, o.occurred_on, o.is_edited
          FROM transaction_series_occurrences o
          JOIN transactions t ON t.id = o.transaction_id
         WHERE o.series_id = v_ser.id
           AND t.profile_id = v_profile
           AND t.deleted_at IS NULL
           AND (   p_scope = 'whole'
                OR (p_scope = 'this'          AND o.occurrence_index = p_from_occurrence)
                OR (p_scope = 'this_and_next' AND o.occurrence_index >= p_from_occurrence))
         ORDER BY o.occurrence_index
    LOOP
        IF p_account_id IS NOT NULL THEN
            PERFORM app.assert_account_for_profile(p_account_id, v_profile, v_oc.occurred_on);
        END IF;
    END LOOP;

    -- template da série: só quando a edição é coletiva (escopo 'this' preserva
    -- a série e marca a ocorrência como editada)
    IF p_scope <> 'this' THEN
        UPDATE transaction_series
           SET display_name = coalesce(trim(p_display_name), display_name),
               amount_total = CASE WHEN p_amount IS NOT NULL THEN p_amount ELSE amount_total END,
               account_id   = coalesce(p_account_id, account_id),
               category_id  = CASE
                                WHEN p_category_action = 'set'   THEN p_category_id
                                WHEN p_category_action = 'clear' THEN NULL
                                ELSE category_id
                              END,
               updated_at   = now()
         WHERE id = v_ser.id;
    END IF;

    -- aplicação nas transações do escopo. status NÃO é tocado fora de 'this'.
    FOR v_oc IN
        SELECT o.id, o.transaction_id, o.occurrence_index, o.occurred_on, o.is_edited
          FROM transaction_series_occurrences o
          JOIN transactions t ON t.id = o.transaction_id
         WHERE o.series_id = v_ser.id
           AND t.profile_id = v_profile
           AND t.deleted_at IS NULL
           AND (   p_scope = 'whole'
                OR (p_scope = 'this'          AND o.occurrence_index = p_from_occurrence)
                OR (p_scope = 'this_and_next' AND o.occurrence_index >= p_from_occurrence))
         ORDER BY o.occurrence_index
    LOOP
        -- (2) is_edited não pula: entra no conjunto
        IF v_oc.is_edited THEN
            v_edited := v_edited + 1;
        END IF;

        -- 'preserve' preserva o valor PRÓPRIO de cada ocorrência
        v_cat := (SELECT t2.category_id FROM transactions t2 WHERE t2.id = v_oc.transaction_id);
        IF p_category_action = 'set' THEN
            v_cat := p_category_id;
        ELSIF p_category_action = 'clear' THEN
            v_cat := NULL;
        END IF;

        -- (3) before_state ANTES da mutação
        SELECT app.tx_state_jsonb(v_oc.transaction_id) INTO v_before;

        UPDATE transactions
           SET raw_description        = coalesce(trim(p_display_name), raw_description),
               normalized_description = coalesce(v_norm, normalized_description),
               account_id             = coalesce(p_account_id, account_id),
               category_id            = v_cat,
               amount                 = CASE WHEN p_amount IS NOT NULL THEN p_amount ELSE amount END,
               memo                   = CASE
                                            WHEN p_memo_action = 'set'   THEN p_memo
                                            WHEN p_memo_action = 'clear' THEN NULL
                                            ELSE memo
                                          END,
               -- status só muda em 'this'; nos demais cada uma mantém o seu
               status                 = CASE WHEN p_scope = 'this' THEN coalesce(p_status, status) ELSE status END,
               updated_at             = now()
         WHERE id = v_oc.transaction_id;

        -- espelho da ocorrência
        UPDATE transaction_series_occurrences
           SET amount = CASE WHEN p_amount IS NOT NULL THEN p_amount ELSE amount END,
               is_edited = CASE WHEN p_scope = 'this' THEN true ELSE is_edited END
         WHERE id = v_oc.id;

        SELECT app.tx_state_jsonb(v_oc.transaction_id) INTO v_after;
        INSERT INTO transaction_audit
            (id, transaction_id, action, before_state, after_state, changed_by)
        VALUES
            (gen_random_uuid(), v_oc.transaction_id, 'update', v_before, v_after, v_sub);
        v_updated := v_updated + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'series_id',          v_ser.id,
        'scope',              p_scope,
        'afetadas',           v_total,
        'atualizadas',        v_updated,
        'ja_excluidas',       v_excl,
        'passadas',           v_pass,
        'pagas',              v_posted,
        'editadas_atingidas', v_edit,
        'status_propagados',  0,
        'conflitos',          0,
        'impacto',            v_impact
    );
END;
$function$;

COMMENT ON FUNCTION app.transaction_series_edit(uuid, integer, text, timestamptz, text, numeric, uuid, text, uuid, text, text, text, boolean, boolean, boolean) IS
    'E10B: edicao por escopo (this|this_and_next|whole). Nao propaga status fora de ''this''. Nao pula is_edited. before_state antes da mutacao. Concorrencia otimista em todos os escopos. category_id/memo usam *_action (preserve|set|clear). Valor em lote bloqueado para installment.';

-- ============================================================================
-- 5) WRAPPERS public.* — o caminho real do app (PostgREST).
--
--    O app chama supabase.rpc('transaction_series_edit' | '_delete' |
--    'series_scope_impact') SEM qualificar o schema, e o PostgREST resolve no
--    schema exposto (public). O catálogo implantado não possui esses wrappers
--    (B03 wrappers_public_dependentes=[]; B12 sem função public de série), o
--    que torna a edição/exclusão de recorrência pela UI inoperante. Aqui o
--    gap é fechado com o menor privilégio possível:
--      - SECURITY INVOKER (o wrapper NÃO é definer; quem executa é o usuário);
--      - search_path fixo 'public, app';
--      - sem PUBLIC e sem anon; somente authenticated.
--    Sem GRANT USAGE em app de propósito: o wrapper é invoker e o usuário só
--    precisa de EXECUTE na função public, cujo corpo delega à app.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.series_scope_impact(
    p_series_id       uuid,
    p_from_occurrence integer,
    p_scope           text
) RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path TO 'public', 'app'
AS $$
    SELECT app.series_scope_impact(p_series_id, p_from_occurrence, p_scope);
$$;

CREATE OR REPLACE FUNCTION public.transaction_series_edit(
    p_series_id           uuid,
    p_from_occurrence     integer,
    p_scope               text,
    p_expected_updated_at timestamptz,
    p_display_name        text        DEFAULT NULL,
    p_amount              numeric     DEFAULT NULL,
    p_account_id          uuid        DEFAULT NULL,
    p_category_action     text        DEFAULT 'preserve',
    p_category_id         uuid        DEFAULT NULL,
    p_memo_action         text        DEFAULT 'preserve',
    p_memo                text        DEFAULT NULL,
    p_status              text        DEFAULT NULL,
    p_confirm_past        boolean     DEFAULT false,
    p_confirm_posted      boolean     DEFAULT false,
    p_confirm_edited      boolean     DEFAULT false
) RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path TO 'public', 'app'
AS $$
    SELECT app.transaction_series_edit(
        p_series_id, p_from_occurrence, p_scope, p_expected_updated_at,
        p_display_name, p_amount, p_account_id,
        p_category_action, p_category_id,
        p_memo_action, p_memo,
        p_status, p_confirm_past, p_confirm_posted, p_confirm_edited
    );
$$;

CREATE OR REPLACE FUNCTION public.transaction_series_delete(
    p_series_id           uuid,
    p_from_occurrence     integer,
    p_scope               text,
    p_expected_updated_at timestamptz,
    p_confirm_past        boolean DEFAULT false,
    p_confirm_posted      boolean DEFAULT false,
    p_confirm_edited      boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path TO 'public', 'app'
AS $$
    SELECT app.transaction_series_delete(
        p_series_id, p_from_occurrence, p_scope, p_expected_updated_at,
        p_confirm_past, p_confirm_posted, p_confirm_edited
    );
$$;

COMMENT ON FUNCTION public.series_scope_impact(uuid, integer, text) IS
    'E10B: wrapper publico (invoker) da previa de impacto por escopo. Somente authenticated.';

-- ============================================================================
-- 6) PRIVILÉGIOS: sem anon/PUBLIC; apenas authenticated.
-- ============================================================================
REVOKE ALL ON FUNCTION app.series_scope_impact(uuid, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app.transaction_series_edit(uuid, integer, text, timestamptz, text, numeric, uuid, text, uuid, text, text, text, boolean, boolean, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app.transaction_series_delete(uuid, integer, text, timestamptz, boolean, boolean, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION app.series_scope_impact(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.transaction_series_edit(uuid, integer, text, timestamptz, text, numeric, uuid, text, uuid, text, text, text, boolean, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION app.transaction_series_delete(uuid, integer, text, timestamptz, boolean, boolean, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.series_scope_impact(uuid, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transaction_series_edit(uuid, integer, text, timestamptz, text, numeric, uuid, text, uuid, text, text, text, boolean, boolean, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transaction_series_delete(uuid, integer, text, timestamptz, boolean, boolean, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.series_scope_impact(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transaction_series_edit(uuid, integer, text, timestamptz, text, numeric, uuid, text, uuid, text, text, text, boolean, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transaction_series_delete(uuid, integer, text, timestamptz, boolean, boolean, boolean) TO authenticated;

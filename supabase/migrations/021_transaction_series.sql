-- ============================================================
-- 021_transaction_series.sql (v2 — gate CFG-P5B)
-- RECORRENCIAS E PARCELAMENTOS (CFG-P5A/P5B, Package 015) — LOCAL, NAO APLICAR.
--
-- Contrato de produto fechado (decisoes do proprietario, CFG-P5A/P5B):
--   A. valor digitado no parcelamento = VALOR TOTAL (12 x R$100 a partir de R$1.200);
--      arredondamento: primeiras N-1 parcelas = floor(total*100/N)/100; ultima =
--      total - soma das anteriores (soma EXATA do total; centavos nunca somem).
--   B. mes sem o dia (29/30/31 em meses curtos; 29/02 nao bissexto) -> ultimo dia
--      do mes (deterministico).
--   C. frequencias suportadas no MVP: weekly | monthly | yearly.
--   D. recorrencia pode ser SEM fim (total_occurrences NULL); materializacao por
--      horizonte controlado (RECURRING_MATERIALIZE_LIMIT = 24) — NUNCA infinito.
--   E. "serie inteira" altera tambem o passado, mas o BACKEND exige
--      p_confirm_past = true quando houver ocorrencias passadas no escopo.
--   F. ocorrencias futuras (occurred_on > current_date) nascem com status
--      'scheduled'; primeira/passadas usam o status escolhido no form.
--      scheduled PERMANECE scheduled ate edicao/acao explicita (sem job).
--   G. materializacao IMEDIATA de parcelas finitas; recorrencia aberta materializa
--      24 na criacao e depois em JANELAS de 24 (materialize idempotente por janela).
--
-- Ciclo de vida estrutural (CFG-P5B itens 2/17):
--   transaction_series.state   : 'active' | 'stopped' | 'completed'
--     active    : serie em uso (novas ocorrencias podem ser materializadas).
--     stopped   : serie encerrada por exclusao (inteira ou "esta e proximas"
--                 a partir da 1a); materialize REJEITA.
--     completed : todas as ocorrencias planejadas (total_occurrences) ja foram
--                 materializadas; materialize retorna 0 (canonico).
--   transaction_series.end_occurrence : limite superior fixo da serie
--     (ex.: exclusao "esta e proximas" a partir de N => end_occurrence = N-1).
--     NULL = sem limite (aberta). Materialize NUNCA cria indice > end_occurrence.
--   transaction_series.materialized_through : maior indice ja materializado
--     (janela). Materialize avanca a partir de max(existente)+1 ate o proximo
--     multiplo de 24; retry no mesmo estado cria 0.
--
-- Identidade NAO depende de texto "(3/12)" na descricao (estrutural).
-- Principios: zero data migration; atomicidade total; idempotencia por
-- idempotency_key + fingerprint de payload; cada ocorrencia e transacao real
-- (transaction_audit cobre); transferencias fora do MVP; RLS/grants/helpers
-- hardening conforme 019/020.
-- ============================================================

BEGIN;

-- ---------- 1. Tabela de series ----------
CREATE TABLE transaction_series (
    id                    uuid PRIMARY KEY,
    profile_id            uuid NOT NULL REFERENCES profiles (id),
    direction             text NOT NULL CHECK (direction IN ('income', 'expense')),
    kind                  text NOT NULL CHECK (kind IN ('installment', 'recurring')),
    frequency             text NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'yearly')),
    display_name          text NOT NULL,
    amount_total          numeric(18, 2) NOT NULL CHECK (amount_total > 0),
    total_occurrences     integer CHECK (total_occurrences IS NULL OR total_occurrences >= 1),
    starts_on             date NOT NULL,
    account_id            uuid NOT NULL REFERENCES accounts (id),
    category_id           uuid REFERENCES categories (id),
    state                 text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'stopped', 'completed')),
    end_occurrence        integer CHECK (end_occurrence IS NULL OR end_occurrence >= 0),
    materialized_through  integer NOT NULL DEFAULT 0 CHECK (materialized_through >= 0),
    idempotency_key       uuid NOT NULL,
    payload_fingerprint   text NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (profile_id, idempotency_key)
);

-- ---------- 2. Ocorrencias (serie <-> transacao) ----------
CREATE TABLE transaction_series_occurrences (
    id                uuid PRIMARY KEY,
    series_id         uuid NOT NULL REFERENCES transaction_series (id) ON DELETE CASCADE,
    transaction_id    uuid NOT NULL UNIQUE REFERENCES transactions (id) ON DELETE CASCADE,
    occurrence_index  integer NOT NULL CHECK (occurrence_index >= 1),
    occurred_on       date NOT NULL,
    amount            numeric(18, 2) NOT NULL CHECK (amount > 0),
    is_edited         boolean NOT NULL DEFAULT false,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (series_id, occurrence_index)
);

CREATE INDEX idx_tso_series      ON transaction_series_occurrences (series_id, occurrence_index);
CREATE INDEX idx_tso_transaction ON transaction_series_occurrences (transaction_id);

-- ---------- 3. RLS + grants (leitura propria; escrita service_role) ----------
ALTER TABLE transaction_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_series_occurrences ENABLE ROW LEVEL SECURITY;

CREATE POLICY series_select_own ON transaction_series FOR SELECT
    USING (app.jwt_role() = 'service_role' OR profile_id = app.jwt_profile_id());
CREATE POLICY series_write_service ON transaction_series FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

CREATE POLICY tso_select_own ON transaction_series_occurrences FOR SELECT
    USING (app.jwt_role() = 'service_role'
           OR EXISTS (SELECT 1 FROM transaction_series s
                       WHERE s.id = transaction_series_occurrences.series_id
                         AND s.profile_id = app.jwt_profile_id()));
CREATE POLICY tso_write_service ON transaction_series_occurrences FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

GRANT SELECT ON transaction_series TO authenticated;
GRANT SELECT ON transaction_series_occurrences TO authenticated;
-- NENHUM grant de INSERT/UPDATE/DELETE para authenticated.

-- ---------- 4. Helpers internos (sem EXECUTE para PUBLIC/authenticated) ----------

-- Proxima data da enesima ocorrencia (1-based), com regra "ultimo dia do mes".
CREATE OR REPLACE FUNCTION app.series_occurrence_date(
    p_base    date,
    p_freq    text,
    p_index   integer
) RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, app
AS $$
DECLARE
    v_d       date;
    v_year    integer;
    v_month   integer;
    v_day     integer;
BEGIN
    IF p_index < 1 THEN
        RETURN NULL;
    END IF;
    IF p_freq = 'weekly' THEN
        RETURN p_base + ((p_index - 1) * 7);
    END IF;
    v_day := extract(day FROM p_base)::integer;
    IF p_freq = 'monthly' THEN
        v_month := extract(month FROM p_base)::integer + (p_index - 1);
        v_year  := extract(year FROM p_base)::integer + ((v_month - 1) / 12);
        v_month := ((v_month - 1) % 12) + 1;
    ELSE -- yearly
        v_year  := extract(year FROM p_base)::integer + (p_index - 1);
        v_month := extract(month FROM p_base)::integer;
    END IF;
    v_d := make_date(v_year, v_month, 1);
    IF v_day > extract(day FROM (v_d + interval '1 month - 1 day'))::integer THEN
        RETURN (v_d + interval '1 month - 1 day')::date;
    END IF;
    RETURN make_date(v_year, v_month, v_day);
END;
$$;

-- Valor da parcela i (1..N) para total T: primeiras N-1 = floor(T*100/N)/100;
-- ultima = T - soma das anteriores (soma exata). Deterministico.
CREATE OR REPLACE FUNCTION app.installment_amount(
    p_total numeric,
    p_index integer,
    p_total_occurrences integer
) RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, app
AS $$
DECLARE
    v_base numeric;
BEGIN
    v_base := floor(p_total * 100 / p_total_occurrences) / 100;
    IF p_index >= p_total_occurrences THEN
        RETURN p_total - (v_base * (p_total_occurrences - 1));
    END IF;
    RETURN v_base;
END;
$$;

-- Status inicial de uma ocorrencia: futuras = scheduled; demais = escolhido.
CREATE OR REPLACE FUNCTION app.series_occurrence_status(
    p_occurred_on date,
    p_status      text
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, app
AS $$
    SELECT CASE WHEN p_occurred_on > current_date THEN 'scheduled' ELSE p_status END;
$$;

-- Fingerprint deterministico do payload de criacao (idempotencia; NUNCA inclui
-- JWT/token/segredo; somente campos de negocio). Usa md5 (built-in, sem extensao)
-- sobre uma concatenacao normalizada — suficiente para detectar payload divergente.
CREATE OR REPLACE FUNCTION app.series_payload_fingerprint(
    p_direction         text,
    p_kind              text,
    p_frequency         text,
    p_display_name      text,
    p_amount            numeric,
    p_total_occurrences integer,
    p_starts_on         date,
    p_account_id        uuid,
    p_category_id       uuid,
    p_status            text
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, app
AS $$
    SELECT md5(
        p_direction || '|' || p_kind || '|' || p_frequency || '|' ||
        coalesce(p_display_name, '') || '|' || coalesce(p_amount, 0)::text || '|' ||
        coalesce(p_total_occurrences, 0)::text || '|' || coalesce(p_starts_on, '1900-01-01')::text || '|' ||
        coalesce(p_account_id, '00000000-0000-0000-0000-000000000000')::text || '|' ||
        coalesce(p_category_id, '00000000-0000-0000-0000-000000000000')::text || '|' ||
        coalesce(p_status, '')
    );
$$;

-- ---------- 5. Preview (read-only; NUNCA escreve) ----------
CREATE OR REPLACE FUNCTION app.transaction_series_preview(
    p_direction          text,
    p_kind               text,
    p_frequency          text,
    p_amount             numeric,
    p_total_occurrences  integer,
    p_starts_on          date,
    p_account_id         uuid,
    p_category_id        uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
    v_n       integer;
    v_rows    jsonb := '[]'::jsonb;
    v_row     jsonb;
    v_date    date;
    v_amount  numeric;
    v_acc_ok  boolean;
    v_cat_ok  boolean;
    v_i       integer;
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    IF p_direction NOT IN ('income', 'expense') THEN
        RAISE EXCEPTION 'direcao invalida';
    END IF;
    IF p_kind NOT IN ('installment', 'recurring') THEN
        RAISE EXCEPTION 'tipo de serie invalido';
    END IF;
    IF p_frequency NOT IN ('weekly', 'monthly', 'yearly') THEN
        RAISE EXCEPTION 'frequencia invalida';
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'valor deve ser positivo';
    END IF;
    IF p_starts_on IS NULL THEN
        RAISE EXCEPTION 'data inicial obrigatoria';
    END IF;
    IF p_account_id IS NULL THEN
        RAISE EXCEPTION 'conta obrigatoria';
    END IF;

    IF p_kind = 'installment' THEN
        IF p_total_occurrences IS NULL OR p_total_occurrences < 1 THEN
            RAISE EXCEPTION 'quantidade de parcelas obrigatoria';
        END IF;
        IF p_total_occurrences > 120 THEN
            RAISE EXCEPTION 'quantidade de parcelas acima do limite (120)';
        END IF;
        v_n := p_total_occurrences;
    ELSE
        v_n := LEAST(coalesce(p_total_occurrences, 24), 120);
    END IF;

    FOR v_i IN 1..v_n LOOP
        v_date := app.series_occurrence_date(p_starts_on, p_frequency, v_i);
        IF p_kind = 'installment' THEN
            v_amount := app.installment_amount(p_amount, v_i, p_total_occurrences);
        ELSE
            v_amount := p_amount;
        END IF;
        SELECT EXISTS (
            SELECT 1 FROM account_profile_periods pp
             WHERE pp.account_id = p_account_id AND pp.profile_id = v_profile
               AND pp.starts_on <= v_date AND (pp.ends_on IS NULL OR pp.ends_on >= v_date)
        ) INTO v_acc_ok;
        v_cat_ok := true;
        IF p_category_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 FROM categories c
                 WHERE c.id = p_category_id AND c.profile_id = v_profile
                   AND c.status = 'active' AND c.direction = p_direction
            ) INTO v_cat_ok;
        END IF;
        v_row := jsonb_build_object(
            'index', v_i, 'occurred_on', v_date, 'amount', v_amount,
            'status', app.series_occurrence_status(v_date, 'posted'),
            'account_valid', v_acc_ok, 'category_valid', v_cat_ok
        );
        v_rows := v_rows || jsonb_build_array(v_row);
    END LOOP;

    RETURN jsonb_build_object(
        'rows', v_rows,
        'total', v_n,
        'direction', p_direction,
        'kind', p_kind,
        'frequency', p_frequency,
        'amount_total', p_amount
    );
END;
$$;

-- ---------- 6. Create (atomico + idempotente por chave + fingerprint) ----------
CREATE OR REPLACE FUNCTION app.transaction_series_create(
    p_idempotency_key   uuid,
    p_direction         text,
    p_kind              text,
    p_frequency         text,
    p_display_name      text,
    p_amount            numeric,
    p_total_occurrences integer,
    p_starts_on         date,
    p_account_id        uuid,
    p_category_id       uuid DEFAULT NULL,
    p_status            text DEFAULT 'posted'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
    v_sub     uuid;
    v_norm    text;
    v_existing record;
    v_fp      text;
    v_series  uuid;
    v_n       integer;
    v_i       integer;
    v_date    date;
    v_amount  numeric;
    v_tx_id   uuid;
    v_status  text;
    v_category uuid;
BEGIN
    v_profile := app.jwt_profile_id();
    v_sub     := app.jwt_sub();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;

    v_fp := app.series_payload_fingerprint(
        p_direction, p_kind, p_frequency, p_display_name, p_amount,
        p_total_occurrences, p_starts_on, p_account_id, p_category_id, p_status);

    -- idempotencia: mesma chave + mesmo perfil => retorna a serie existente
    -- SOMENTE se o fingerprint do payload bater; payload diferente => CONFLITO.
    SELECT * INTO v_existing FROM transaction_series
     WHERE profile_id = v_profile AND idempotency_key = p_idempotency_key;
    IF v_existing.id IS NOT NULL THEN
        IF v_existing.payload_fingerprint <> v_fp THEN
            RAISE EXCEPTION 'CONFLITO: idempotency key ja utilizada com payload diferente (fingerprint divergente)';
        END IF;
        RETURN jsonb_build_object('series_id', v_existing.id, 'created', false, 'duplicated', true);
    END IF;

    IF p_direction NOT IN ('income', 'expense') THEN
        RAISE EXCEPTION 'direcao invalida';
    END IF;
    IF p_kind NOT IN ('installment', 'recurring') THEN
        RAISE EXCEPTION 'tipo de serie invalido';
    END IF;
    IF p_kind = 'installment' AND p_frequency <> 'monthly' THEN
        RAISE EXCEPTION 'parcelamento usa frequencia mensal';
    END IF;
    IF p_frequency NOT IN ('weekly', 'monthly', 'yearly') THEN
        RAISE EXCEPTION 'frequencia invalida';
    END IF;
    IF p_display_name IS NULL OR trim(p_display_name) = '' THEN
        RAISE EXCEPTION 'descricao obrigatoria';
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'valor deve ser positivo';
    END IF;
    IF p_starts_on IS NULL THEN
        RAISE EXCEPTION 'data inicial obrigatoria';
    END IF;
    IF p_account_id IS NULL THEN
        RAISE EXCEPTION 'conta obrigatoria';
    END IF;
    IF p_status IS NULL OR p_status NOT IN ('posted','pending') THEN
        RAISE EXCEPTION 'status invalido para serie (posted|pending)';
    END IF;
    v_norm := app.normalize_description(p_display_name);

    IF p_kind = 'installment' THEN
        IF p_total_occurrences IS NULL OR p_total_occurrences < 1 OR p_total_occurrences > 120 THEN
            RAISE EXCEPTION 'quantidade de parcelas deve estar entre 1 e 120';
        END IF;
        v_n := p_total_occurrences;
    ELSE
        v_n := LEAST(coalesce(p_total_occurrences, 24), 120);
    END IF;

    -- validacoes por ocorrencia (bloqueiam o lote inteiro; nada e gravado antes)
    FOR v_i IN 1..v_n LOOP
        v_date := app.series_occurrence_date(p_starts_on, p_frequency, v_i);
        PERFORM app.assert_account_for_profile(p_account_id, v_profile, v_date);
        IF p_category_id IS NOT NULL THEN
            PERFORM app.resolve_category_for_profile(p_category_id, p_direction, v_profile);
        END IF;
    END LOOP;

    INSERT INTO transaction_series
        (id, profile_id, direction, kind, frequency, display_name, amount_total,
         total_occurrences, starts_on, account_id, category_id, state, end_occurrence,
         materialized_through, idempotency_key, payload_fingerprint, created_at, updated_at)
    VALUES
        (gen_random_uuid(), v_profile, p_direction, p_kind, p_frequency, trim(p_display_name), p_amount,
         p_total_occurrences, p_starts_on, p_account_id, p_category_id, 'active', NULL,
         v_n, p_idempotency_key, v_fp, now(), now())
    RETURNING id INTO v_series;

    FOR v_i IN 1..v_n LOOP
        v_date   := app.series_occurrence_date(p_starts_on, p_frequency, v_i);
        v_amount := CASE WHEN p_kind = 'installment'
                         THEN app.installment_amount(p_amount, v_i, p_total_occurrences)
                         ELSE p_amount END;
        v_status := app.series_occurrence_status(v_date, p_status);
        v_category := NULL;
        IF p_category_id IS NOT NULL THEN
            v_category := app.resolve_category_for_profile(p_category_id, p_direction, v_profile);
        END IF;
        v_tx_id := gen_random_uuid();
        INSERT INTO transactions
            (id, profile_id, account_id, category_id, transaction_kind, amount, occurred_on,
             raw_description, normalized_description, memo, status, updated_at)
        VALUES
            (v_tx_id, v_profile, p_account_id, v_category, p_direction, v_amount, v_date,
             trim(p_display_name), v_norm, NULL, v_status, now());
        INSERT INTO transaction_series_occurrences
            (id, series_id, transaction_id, occurrence_index, occurred_on, amount, is_edited, created_at)
        VALUES
            (gen_random_uuid(), v_series, v_tx_id, v_i, v_date, v_amount, false, now());
        INSERT INTO transaction_audit
            (id, transaction_id, action, before_state, after_state, changed_by)
        VALUES
            (gen_random_uuid(), v_tx_id, 'create', NULL, app.tx_state_jsonb(v_tx_id), v_sub);
    END LOOP;

    -- finita completamente materializada => completed; aberta => active
    UPDATE transaction_series
       SET state = CASE WHEN (p_kind = 'installment' OR p_total_occurrences IS NOT NULL)
                        THEN 'completed' ELSE 'active' END
     WHERE id = v_series;

    RETURN jsonb_build_object(
        'series_id', v_series,
        'created', true,
        'occurrences', v_n,
        'kind', p_kind,
        'frequency', p_frequency
    );
END;
$$;

-- ---------- 7. Edit em lote (escopos this|this_and_next|whole) ----------
-- this_and_next/whole: ocorrencias com is_edited=true sao PRESERVADAS (nunca
-- sobrescritas inadvertidamente); "esta e proximas" nunca toca ocorrencias
-- ANTERIORES, mas ATUALIZA o TEMPLATE da serie para que ocorrencias ainda nao
-- materializadas usem a nova configuracao (CFG-P5B item 6).
-- whole com passado no escopo exige p_confirm_past = true (CFG-P5B item 8).
CREATE OR REPLACE FUNCTION app.transaction_series_edit(
    p_series_id           uuid,
    p_from_occurrence     integer,
    p_scope               text,
    p_expected_updated_at timestamptz,
    p_display_name        text DEFAULT NULL,
    p_amount              numeric DEFAULT NULL,
    p_account_id          uuid DEFAULT NULL,
    p_category_id         uuid DEFAULT NULL,
    p_status              text DEFAULT NULL,
    p_memo                text DEFAULT NULL,
    p_confirm_past        boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
    v_sub     uuid;
    v_ser     record;
    v_norm    text;
    v_updated integer := 0;
    v_skipped integer := 0;
    v_oc      record;
    v_cat     uuid;
    v_pivot   timestamptz;
    v_has_past boolean;
BEGIN
    v_profile := app.jwt_profile_id();
    v_sub     := app.jwt_sub();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    SELECT * INTO v_ser FROM transaction_series s
     WHERE s.id = p_series_id AND s.profile_id = v_profile
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'serie nao encontrada neste perfil';
    END IF;
    IF p_scope NOT IN ('this', 'this_and_next', 'whole') THEN
        RAISE EXCEPTION 'escopo invalido';
    END IF;
    IF p_scope <> 'whole' AND p_from_occurrence IS NULL THEN
        RAISE EXCEPTION 'ocorrencia de partida obrigatoria';
    END IF;
    IF p_amount IS NOT NULL AND v_ser.kind = 'installment' THEN
        RAISE EXCEPTION 'parcelamento nao permite alterar valor em lote; edite ocorrencias individualmente';
    END IF;
    IF p_scope = 'whole' AND p_amount IS NOT NULL AND v_ser.kind = 'recurring' AND p_amount <= 0 THEN
        RAISE EXCEPTION 'valor deve ser positivo';
    END IF;

    -- lock otimista: a ocorrencia de partida precisa ter updated_at esperado
    IF p_scope <> 'whole' THEN
        SELECT t.updated_at INTO v_pivot
          FROM transaction_series_occurrences o
          JOIN transactions t ON t.id = o.transaction_id
         WHERE o.series_id = v_ser.id AND o.occurrence_index = p_from_occurrence;
        IF v_pivot IS NULL THEN
            RAISE EXCEPTION 'ocorrencia de partida nao encontrada';
        END IF;
        IF p_expected_updated_at IS NOT NULL
           AND abs(extract(epoch FROM (v_pivot - p_expected_updated_at))) > 0.001 THEN
            RAISE EXCEPTION 'CONFLITO: serie foi modificada por outra operacao';
        END IF;
    END IF;

    IF p_display_name IS NOT NULL THEN
        IF trim(p_display_name) = '' THEN
            RAISE EXCEPTION 'descricao obrigatoria';
        END IF;
        v_norm := app.normalize_description(p_display_name);
    END IF;
    IF p_status IS NOT NULL AND p_status NOT IN ('posted','pending','scheduled') THEN
        RAISE EXCEPTION 'status invalido';
    END IF;
    IF p_account_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM account_profile_periods pp
                        WHERE pp.account_id = p_account_id AND pp.profile_id = v_profile) THEN
            RAISE EXCEPTION 'conta nao esta disponivel no perfil';
        END IF;
    END IF;

    -- confirmação explícita de passado (CFG-P5B item 8): scope whole com
    -- ocorrencia passada NAO is_edited no escopo exige confirm_past=true.
    IF p_scope = 'whole' THEN
        SELECT EXISTS (
            SELECT 1 FROM transaction_series_occurrences o
             WHERE o.series_id = v_ser.id
               AND o.occurred_on < current_date
               AND NOT o.is_edited
        ) INTO v_has_past;
        IF v_has_past AND NOT p_confirm_past THEN
            RAISE EXCEPTION 'serie possui ocorrencias passadas; confirme a alteracao de passado (confirm_past=true)'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- atualiza o TEMPLATE da serie (aplicado a ocorrencias ainda nao materializadas).
    -- Escopo 'this' NUNCA toca o template (ocorrencia individual divergente).
    IF p_scope <> 'this' THEN
        UPDATE transaction_series
           SET display_name     = coalesce(trim(p_display_name), display_name),
               amount_total     = CASE WHEN p_amount IS NOT NULL THEN p_amount ELSE amount_total END,
               account_id       = coalesce(p_account_id, account_id),
               category_id      = CASE WHEN p_category_id IS NOT NULL THEN p_category_id ELSE category_id END,
               updated_at       = now()
         WHERE id = v_ser.id;
    END IF;

    FOR v_oc IN
        SELECT o.*
          FROM transaction_series_occurrences o
         WHERE o.series_id = v_ser.id
           AND (p_scope = 'whole'
                OR (p_scope = 'this' AND o.occurrence_index = p_from_occurrence)
                OR (p_scope = 'this_and_next' AND o.occurrence_index >= p_from_occurrence))
         ORDER BY o.occurrence_index
    LOOP
        IF v_oc.is_edited AND p_scope <> 'this' THEN
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;
        IF p_account_id IS NOT NULL THEN
            PERFORM app.assert_account_for_profile(p_account_id, v_profile, v_oc.occurred_on);
        END IF;
        v_cat := v_ser.category_id;
        IF p_category_id IS NOT NULL THEN
            PERFORM app.resolve_category_for_profile(p_category_id, v_ser.direction, v_profile);
            v_cat := p_category_id;
        END IF;
        UPDATE transactions
           SET raw_description        = coalesce(trim(p_display_name), raw_description),
               normalized_description = coalesce(v_norm, normalized_description),
               account_id             = coalesce(p_account_id, account_id),
               category_id            = v_cat,
               amount                 = CASE WHEN p_amount IS NOT NULL AND v_ser.kind = 'recurring' THEN p_amount ELSE amount END,
               status                 = coalesce(p_status, status),
               memo                   = coalesce(p_memo, memo),
               updated_at             = now()
         WHERE id = v_oc.transaction_id;
        IF p_scope = 'this' THEN
            UPDATE transaction_series_occurrences SET is_edited = true WHERE id = v_oc.id;
        END IF;
        INSERT INTO transaction_audit
            (id, transaction_id, action, before_state, after_state, changed_by)
        VALUES
            (gen_random_uuid(), v_oc.transaction_id, 'update',
             app.tx_state_jsonb(v_oc.transaction_id),
             (SELECT to_jsonb(t2) FROM transactions t2 WHERE t2.id = v_oc.transaction_id), v_sub);
        v_updated := v_updated + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'series_id', v_ser.id,
        'updated', v_updated,
        'skipped_edited', v_skipped,
        'scope', p_scope
    );
END;
$$;

-- ---------- 8. Delete em lote (soft-delete atomico; preserva historico) ----------
-- this                : somente a ocorrencia (indice permanece ocupado -> materialize
--                        nunca recria aquele indice; serie continua active).
-- this_and_next       : fecha a serie em end_occurrence = N-1 (materialize NAO cria
--                        N, N+1, ...); 1..N-1 intactas; state active se restou algo.
-- whole                : todas soft-deleted; state = stopped; exige confirm_past
--                        quando ha ocorrencias passadas; materialize rejeita.
CREATE OR REPLACE FUNCTION app.transaction_series_delete(
    p_series_id           uuid,
    p_from_occurrence     integer,
    p_scope               text,
    p_expected_updated_at timestamptz,
    p_confirm_past        boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
    v_sub     uuid;
    v_ser     record;
    v_deleted integer := 0;
    v_skipped integer := 0;
    v_oc      record;
    v_now     timestamptz := now();
    v_pivot   timestamptz;
    v_has_past boolean;
    v_alive_before integer;
BEGIN
    v_profile := app.jwt_profile_id();
    v_sub     := app.jwt_sub();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    SELECT * INTO v_ser FROM transaction_series s
     WHERE s.id = p_series_id AND s.profile_id = v_profile
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'serie nao encontrada neste perfil';
    END IF;
    IF p_scope NOT IN ('this', 'this_and_next', 'whole') THEN
        RAISE EXCEPTION 'escopo invalido';
    END IF;
    IF p_scope <> 'whole' AND p_from_occurrence IS NULL THEN
        RAISE EXCEPTION 'ocorrencia de partida obrigatoria';
    END IF;

    IF p_scope <> 'whole' THEN
        SELECT t.updated_at INTO v_pivot
          FROM transaction_series_occurrences o
          JOIN transactions t ON t.id = o.transaction_id
         WHERE o.series_id = v_ser.id AND o.occurrence_index = p_from_occurrence;
        IF v_pivot IS NULL THEN
            RAISE EXCEPTION 'ocorrencia de partida nao encontrada';
        END IF;
        IF p_expected_updated_at IS NOT NULL
           AND abs(extract(epoch FROM (v_pivot - p_expected_updated_at))) > 0.001 THEN
            RAISE EXCEPTION 'CONFLITO: serie foi modificada por outra operacao';
        END IF;
    END IF;

    -- confirmacao de passado (whole)
    IF p_scope = 'whole' THEN
        SELECT EXISTS (
            SELECT 1 FROM transaction_series_occurrences o
             WHERE o.series_id = v_ser.id AND o.occurred_on < current_date
        ) INTO v_has_past;
        IF v_has_past AND NOT p_confirm_past THEN
            RAISE EXCEPTION 'serie possui ocorrencias passadas; confirme a exclusao de passado (confirm_past=true)'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    SELECT count(*) INTO v_alive_before FROM transaction_series_occurrences o
      JOIN transactions t ON t.id = o.transaction_id
     WHERE o.series_id = v_ser.id AND t.deleted_at IS NULL;

    FOR v_oc IN
        SELECT o.*
          FROM transaction_series_occurrences o
         WHERE o.series_id = v_ser.id
           AND (p_scope = 'whole'
                OR (p_scope = 'this' AND o.occurrence_index = p_from_occurrence)
                OR (p_scope = 'this_and_next' AND o.occurrence_index >= p_from_occurrence))
         ORDER BY o.occurrence_index
    LOOP
        IF v_oc.is_edited AND p_scope <> 'this' THEN
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;
        UPDATE transactions
           SET deleted_at = v_now, updated_at = now()
         WHERE id = v_oc.transaction_id AND deleted_at IS NULL;
        IF FOUND THEN
            INSERT INTO transaction_audit
                (id, transaction_id, action, before_state, after_state, changed_by)
            VALUES
                (gen_random_uuid(), v_oc.transaction_id, 'delete',
                 app.tx_state_jsonb(v_oc.transaction_id),
                 jsonb_build_object('deleted_at', v_now), v_sub);
            v_deleted := v_deleted + 1;
        END IF;
    END LOOP;

    -- atualiza ciclo de vida da serie
    IF p_scope = 'this' THEN
        -- serie continua ativa; indice continua ocupado no mapping (nao recriado)
        UPDATE transaction_series SET updated_at = now() WHERE id = v_ser.id;
    ELSIF p_scope = 'this_and_next' THEN
        -- fecha a serie em N-1 (ou 0 se N=1) — materialize nao cria N, N+1...
        UPDATE transaction_series
           SET end_occurrence = CASE WHEN p_from_occurrence = 1 THEN 0
                                     ELSE p_from_occurrence - 1 END,
               state = CASE WHEN p_from_occurrence = 1 THEN 'stopped' ELSE 'active' END,
               materialized_through = LEAST(materialized_through, CASE WHEN p_from_occurrence = 1 THEN 0 ELSE p_from_occurrence - 1 END),
               updated_at = now()
         WHERE id = v_ser.id;
    ELSE
        UPDATE transaction_series
           SET state = 'stopped', end_occurrence = 0, updated_at = now()
         WHERE id = v_ser.id;
    END IF;

    RETURN jsonb_build_object(
        'series_id', v_ser.id,
        'deleted', v_deleted,
        'skipped_edited', v_skipped,
        'scope', p_scope,
        'state', (SELECT state FROM transaction_series WHERE id = v_ser.id)
    );
END;
$$;

-- ---------- 9. Materialize (janelas de 24; idempotente por estado) ----------
-- A partir do maior occurrence_index existente + 1, avanca ate o proximo
-- multiplo de 24 (ou end_occurrence / total_occurrences, se menor). Retry no
-- mesmo estado cria 0. Valida conta/categoria de TODAS as novas ocorrencias
-- ANTES de inserir (bloqueio atomico). state=stopped => rejeita;
-- state=completed => retorna 0 (canonico).
CREATE OR REPLACE FUNCTION app.transaction_series_materialize(
    p_series_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
    v_sub     uuid;
    v_ser     record;
    v_max_idx integer;
    v_target  integer;
    v_i       integer;
    v_date    date;
    v_tx_id   uuid;
    v_status  text;
    v_category uuid;
    v_created integer := 0;
BEGIN
    v_profile := app.jwt_profile_id();
    v_sub     := app.jwt_sub();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    SELECT * INTO v_ser FROM transaction_series s
     WHERE s.id = p_series_id AND s.profile_id = v_profile
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'serie nao encontrada neste perfil';
    END IF;
    IF v_ser.kind <> 'recurring' THEN
        RAISE EXCEPTION 'materializacao aplica-se somente a recorrencias';
    END IF;
    IF v_ser.state = 'stopped' THEN
        RAISE EXCEPTION 'serie encerrada; nao e possivel gerar novas ocorrencias';
    END IF;
    IF v_ser.state = 'completed' THEN
        RETURN jsonb_build_object('series_id', v_ser.id, 'created', 0, 'state', 'completed');
    END IF;

    SELECT coalesce(max(occurrence_index), 0) INTO v_max_idx
      FROM transaction_series_occurrences WHERE series_id = v_ser.id;

    -- proxima janela de 24 a partir do ultimo indice materializado (materialized_through).
    -- materialized_through so avanca quando a janela esta completa; retry no mesmo
    -- estado (janela ja criada) => v_target <= v_max_idx => cria 0 (idempotente).
    v_target := v_ser.materialized_through + 24;
    IF v_ser.end_occurrence IS NOT NULL THEN
        v_target := LEAST(v_target, v_ser.end_occurrence);
    END IF;
    IF v_ser.total_occurrences IS NOT NULL THEN
        v_target := LEAST(v_target, v_ser.total_occurrences);
    END IF;
    IF v_target <= v_max_idx THEN
        RETURN jsonb_build_object('series_id', v_ser.id, 'created', 0, 'state', v_ser.state);
    END IF;

    -- validacao ANTECIPADA de todas as novas ocorrencias (lote atomico)
    FOR v_i IN (v_max_idx + 1)..v_target LOOP
        v_date := app.series_occurrence_date(v_ser.starts_on, v_ser.frequency, v_i);
        PERFORM app.assert_account_for_profile(v_ser.account_id, v_profile, v_date);
        IF v_ser.category_id IS NOT NULL THEN
            PERFORM app.resolve_category_for_profile(v_ser.category_id, v_ser.direction, v_profile);
        END IF;
    END LOOP;

    FOR v_i IN (v_max_idx + 1)..v_target LOOP
        v_date := app.series_occurrence_date(v_ser.starts_on, v_ser.frequency, v_i);
        v_status := app.series_occurrence_status(v_date, 'posted');
        v_category := NULL;
        IF v_ser.category_id IS NOT NULL THEN
            v_category := app.resolve_category_for_profile(v_ser.category_id, v_ser.direction, v_profile);
        END IF;
        v_tx_id := gen_random_uuid();
        INSERT INTO transactions
            (id, profile_id, account_id, category_id, transaction_kind, amount, occurred_on,
             raw_description, normalized_description, memo, status, updated_at)
        VALUES
            (v_tx_id, v_profile, v_ser.account_id, v_category, v_ser.direction, v_ser.amount_total, v_date,
             v_ser.display_name, app.normalize_description(v_ser.display_name), NULL, v_status, now());
        INSERT INTO transaction_series_occurrences
            (id, series_id, transaction_id, occurrence_index, occurred_on, amount, is_edited, created_at)
        VALUES
            (gen_random_uuid(), v_ser.id, v_tx_id, v_i, v_date, v_ser.amount_total, false, now());
        INSERT INTO transaction_audit
            (id, transaction_id, action, before_state, after_state, changed_by)
        VALUES
            (gen_random_uuid(), v_tx_id, 'create', NULL, app.tx_state_jsonb(v_tx_id), v_sub);
        v_created := v_created + 1;
    END LOOP;

    UPDATE transaction_series
       SET materialized_through = v_target,
           state = CASE WHEN v_ser.total_occurrences IS NOT NULL AND v_target >= v_ser.total_occurrences
                        THEN 'completed' ELSE 'active' END,
           updated_at = now()
     WHERE id = v_ser.id;

    RETURN jsonb_build_object(
        'series_id', v_ser.id, 'created', v_created,
        'state', (SELECT state FROM transaction_series WHERE id = v_ser.id)
    );
END;
$$;

-- ---------- 10. Wrappers public.* (INVOKER; grants) ----------
CREATE OR REPLACE FUNCTION public.transaction_series_preview(
    p_direction text, p_kind text, p_frequency text, p_amount numeric,
    p_total_occurrences integer, p_starts_on date, p_account_id uuid,
    p_category_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public, app
AS $$
    SELECT app.transaction_series_preview(p_direction, p_kind, p_frequency, p_amount, p_total_occurrences, p_starts_on, p_account_id, p_category_id);
$$;

CREATE OR REPLACE FUNCTION public.transaction_series_create(
    p_idempotency_key uuid, p_direction text, p_kind text, p_frequency text,
    p_display_name text, p_amount numeric, p_total_occurrences integer,
    p_starts_on date, p_account_id uuid, p_category_id uuid DEFAULT NULL,
    p_status text DEFAULT 'posted'
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public, app
AS $$
    SELECT app.transaction_series_create(p_idempotency_key, p_direction, p_kind, p_frequency, p_display_name, p_amount, p_total_occurrences, p_starts_on, p_account_id, p_category_id, p_status);
$$;

CREATE OR REPLACE FUNCTION public.transaction_series_edit(
    p_series_id uuid, p_from_occurrence integer, p_scope text,
    p_expected_updated_at timestamptz,
    p_display_name text DEFAULT NULL, p_amount numeric DEFAULT NULL,
    p_account_id uuid DEFAULT NULL, p_category_id uuid DEFAULT NULL,
    p_status text DEFAULT NULL, p_memo text DEFAULT NULL,
    p_confirm_past boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public, app
AS $$
    SELECT app.transaction_series_edit(p_series_id, p_from_occurrence, p_scope, p_expected_updated_at, p_display_name, p_amount, p_account_id, p_category_id, p_status, p_memo, p_confirm_past);
$$;

CREATE OR REPLACE FUNCTION public.transaction_series_delete(
    p_series_id uuid, p_from_occurrence integer, p_scope text,
    p_expected_updated_at timestamptz, p_confirm_past boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public, app
AS $$
    SELECT app.transaction_series_delete(p_series_id, p_from_occurrence, p_scope, p_expected_updated_at, p_confirm_past);
$$;

CREATE OR REPLACE FUNCTION public.transaction_series_materialize(p_series_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public, app
AS $$
    SELECT app.transaction_series_materialize(p_series_id);
$$;

-- ---------- 11. Hardening + grants ----------
REVOKE ALL ON FUNCTION app.series_occurrence_date(date, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.series_occurrence_date(date, text, integer) FROM authenticated;
REVOKE ALL ON FUNCTION app.installment_amount(numeric, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.installment_amount(numeric, integer, integer) FROM authenticated;
REVOKE ALL ON FUNCTION app.series_occurrence_status(date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.series_occurrence_status(date, text) FROM authenticated;
REVOKE ALL ON FUNCTION app.series_payload_fingerprint(text, text, text, text, numeric, integer, date, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.series_payload_fingerprint(text, text, text, text, numeric, integer, date, uuid, uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION app.transaction_series_preview(text, text, text, numeric, integer, date, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.transaction_series_create(uuid, text, text, text, text, numeric, integer, date, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.transaction_series_edit(uuid, integer, text, timestamptz, text, numeric, uuid, uuid, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.transaction_series_delete(uuid, integer, text, timestamptz, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.transaction_series_materialize(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.transaction_series_preview(text, text, text, numeric, integer, date, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.transaction_series_create(uuid, text, text, text, text, numeric, integer, date, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.transaction_series_edit(uuid, integer, text, timestamptz, text, numeric, uuid, uuid, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION app.transaction_series_delete(uuid, integer, text, timestamptz, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION app.transaction_series_materialize(uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.transaction_series_preview(text, text, text, numeric, integer, date, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transaction_series_create(uuid, text, text, text, text, numeric, integer, date, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transaction_series_edit(uuid, integer, text, timestamptz, text, numeric, uuid, uuid, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transaction_series_delete(uuid, integer, text, timestamptz, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transaction_series_materialize(uuid) TO authenticated;

COMMIT;
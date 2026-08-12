-- ============================================================================
-- SEED_DEMO.sql
-- Seed 100% SINTETICO para demonstracao no Supabase Cloud.
-- Contem somente dados ficticios (contas, categorias e transacoes de exemplo).
-- Nenhum dado financeiro local, real, usuario ou senha e incluido.
--
-- CORRECAO aplicada: as categorias usavam profile_id = NULL, o que viola a
-- constraint NOT NULL de categories.profile_id. Agora os perfis sao localizados
-- dinamicamente em public.profiles por code ('personal'/'business'), validados
-- antes de qualquer INSERT, e o seed roda em um bloco transacional unico:
-- qualquer erro desfaz tudo. Idempotente (nao duplica registros).
--
-- REQUISITO: executar DEPOIS do SETUP_SUPABASE_CLOUD.sql e de criar os usuarios
-- no Authentication (Authentication -> Add user) — o trigger handle_new_user
-- cria os profiles no cadastro.
-- ============================================================================

DO $$
DECLARE
  v_personal_id uuid;
  v_business_id uuid;
BEGIN
  -- ---------- 1) localiza os perfis dinamicamente ----------
  SELECT id INTO v_personal_id FROM public.profiles WHERE code = 'personal';
  SELECT id INTO v_business_id FROM public.profiles WHERE code = 'business';

  -- ---------- 2) valida os dois perfis antes de qualquer INSERT ----------
  IF v_personal_id IS NULL THEN
    RAISE EXCEPTION 'perfil "personal" ausente em public.profiles: crie o usuario no Auth antes do seed';
  END IF;
  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'perfil "business" ausente em public.profiles: crie o usuario no Auth antes do seed';
  END IF;

  -- ---------- 3) contas sinteticas ----------
  INSERT INTO accounts (id, source_name, display_name, normalized_name, account_type, is_active, is_favorite, usage_score)
  VALUES
    ('10000000-0000-4000-8000-000000000001', 'BancoDemo', 'Banco Demo', 'bancodemo', 'bank', TRUE, FALSE, 10),
    ('10000000-0000-4000-8000-000000000002', 'CartaoDemo', 'Cartao Demo', 'cartaodemo', 'credit_card', TRUE, FALSE, 8),
    ('10000000-0000-4000-8000-000000000003', 'CarteiraDemo', 'Carteira Demo', 'carteirademo', 'cash', TRUE, FALSE, 5)
  ON CONFLICT (normalized_name) DO NOTHING;

  -- ---------- 4) categorias hierarquicas sinteticas (perfil business, que possui
  --              as transacoes sinteticas; profile_id NUNCA e NULL — a coluna e NOT NULL) ----------
  INSERT INTO categories (id, profile_id, direction, parent_id, source_name, display_name, normalized_name, canonical_path, status)
  VALUES
    ('20000000-0000-4000-8000-000000000001', v_business_id, 'income', NULL, 'SYNTH', 'Receitas', 'receitas', 'Receitas', 'active'),
    ('20000000-0000-4000-8000-000000000002', v_business_id, 'income', '20000000-0000-4000-8000-000000000001', 'SYNTH', 'Salário', 'salario', 'Receitas / Salário', 'active'),
    ('20000000-0000-4000-8000-000000000003', v_business_id, 'income', '20000000-0000-4000-8000-000000000001', 'SYNTH', 'Freelance', 'freelance', 'Receitas / Freelance', 'active'),
    ('20000000-0000-4000-8000-000000000004', v_business_id, 'expense', NULL, 'SYNTH', 'Alimentação', 'alimentacao', 'Alimentação', 'active'),
    ('20000000-0000-4000-8000-000000000005', v_business_id, 'expense', '20000000-0000-4000-8000-000000000004', 'SYNTH', 'Restaurantes', 'restaurantes', 'Alimentação / Restaurantes', 'active'),
    ('20000000-0000-4000-8000-000000000006', v_business_id, 'expense', '20000000-0000-4000-8000-000000000004', 'SYNTH', 'Mercado', 'mercado', 'Alimentação / Mercado', 'active'),
    ('20000000-0000-4000-8000-000000000007', v_business_id, 'expense', NULL, 'SYNTH', 'Transporte', 'transporte', 'Transporte', 'active'),
    ('20000000-0000-4000-8000-000000000008', v_business_id, 'expense', '20000000-0000-4000-8000-000000000007', 'SYNTH', 'Combustível', 'combustivel', 'Transporte / Combustível', 'active'),
    ('20000000-0000-4000-8000-000000000009', v_business_id, 'expense', NULL, 'SYNTH', 'Moradia', 'moradia', 'Moradia', 'active'),
    ('20000000-0000-4000-8000-000000000010', v_business_id, 'expense', '20000000-0000-4000-8000-000000000009', 'SYNTH', 'Aluguel', 'aluguel', 'Moradia / Aluguel', 'active'),
    ('20000000-0000-4000-8000-000000000011', v_business_id, 'expense', '20000000-0000-4000-8000-000000000009', 'SYNTH', 'Contas', 'contas', 'Moradia / Contas', 'active'),
    ('20000000-0000-4000-8000-000000000012', v_business_id, 'expense', NULL, 'SYNTH', 'Lazer', 'lazer', 'Lazer', 'active')
  ON CONFLICT (id) DO NOTHING;

  -- ---------- 5) transacoes sinteticas (perfil business) ----------
  -- Idempotencia via NOT EXISTS: a UNIQUE (import_batch_id, external_record_id) nao
  -- protege reexecucao quando import_batch_id e NULL, entao o conflito e evitado na origem.
  INSERT INTO transactions (id, profile_id, account_id, transaction_kind, amount, occurred_on, raw_description, normalized_description, category_id, status, external_record_id)
  SELECT
    gen_random_uuid(),
    v_business_id,
    '10000000-0000-4000-8000-000000000001',
    t.kind, t.amount::numeric, t.occurred_on::date, t.raw, t.norm, t.cat::uuid, t.status, t.ext
  FROM (VALUES
    ('income', 5000.00, CURRENT_DATE - 10, 'Transferência recebida - Cliente Exemplo', 'transferencia recebida cliente exemplo', '20000000-0000-4000-8000-000000000002', 'posted', 'SYNTH-001'),
    ('expense', 89.90,  CURRENT_DATE - 8,  'Supermercado Central', 'supermercado central', '20000000-0000-4000-8000-000000000006', 'posted', 'SYNTH-002'),
    ('expense', 45.00,  CURRENT_DATE - 6,  'Posto Shell', 'posto shell', NULL, 'review', 'SYNTH-003'),
    ('expense', 250.00, CURRENT_DATE - 5,  'Restaurante Central', 'restaurante central', NULL, 'review', 'SYNTH-004'),
    ('expense', 1200.00, CURRENT_DATE - 4, 'Aluguel escritório', 'aluguel escritorio', NULL, 'review', 'SYNTH-005'),
    ('income', 1500.00, CURRENT_DATE - 3,  'Freela projeto X', 'freela projeto x', NULL, 'review', 'SYNTH-006')
  ) AS t(kind, amount, occurred_on, raw, norm, cat, status, ext)
  WHERE NOT EXISTS (SELECT 1 FROM transactions x WHERE x.external_record_id = t.ext);

  -- ---------- 6) fila de revisao para as transacoes sinteticas sem categoria ----------
  INSERT INTO reclassification_queue (id, transaction_id, reason, status)
  SELECT gen_random_uuid(), t.id, 'sem_categoria', 'open'
  FROM transactions t
  WHERE t.external_record_id IN ('SYNTH-003', 'SYNTH-004', 'SYNTH-005', 'SYNTH-006')
    AND NOT EXISTS (
      SELECT 1 FROM reclassification_queue q
      WHERE q.transaction_id = t.id AND q.reason = 'sem_categoria' AND q.status = 'open'
    );

  RAISE NOTICE 'Seed sintetico aplicado com sucesso (personal=%, business=%)',
    v_personal_id, v_business_id;
EXCEPTION WHEN OTHERS THEN
  -- qualquer erro desfaz tudo o que o bloco fez (transacao unica)
  RAISE;
END;
$$;

-- 007_cloud_compat.sql — Compatibilidade Supabase Cloud (APLICAR NO SQL EDITOR DO PROJETO CLOUD)
-- Não faz parte das migrations locais do gateway pglite: é a camada que adapta o schema
-- ao PostgREST/Auth do Supabase Cloud.
--
-- O QUE ESTE ARQUIVO FAZ:
--  1) app.jwt_profile_id() passa a ler profile_id de app_metadata (o JWT do GoTrue coloca
--     raw_app_meta_data dentro de app_metadata — o claim não fica no nível raiz do JWT);
--  2) trigger handle_new_user: ao criar um usuário em auth.users, garante o profile na
--     tabela profiles (por code) e grava profile_id/profile_code em raw_app_meta_data;
--  3) overload de assign_category_atomic com 2 argumentos, derivando o profile do JWT
--     (o gateway local injetava o 3º argumento; no Cloud quem injeta é o claim).
--  4) grants de escrita para authenticated nas tabelas usadas pelo app (as políticas RLS
--     continuam restringindo a leitura ao próprio perfil; escrita de categoria via RPC).

-- ---------- 1) jwt_profile_id compatível com o JWT do Supabase Cloud ----------
CREATE OR REPLACE FUNCTION app.jwt_profile_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT nullif(
      coalesce(
        current_setting('request.jwt.claims', true)::jsonb #>> '{app_metadata, profile_id}',
        current_setting('request.jwt.claims', true)::jsonb ->> 'profile_id'
      ), ''
    )::uuid;
$$;

-- ---------- 2) trigger de novo usuário (auth.users -> profiles + app_metadata) ----------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code       text;
  v_profile_id uuid;
  v_display    text;
BEGIN
  v_code := coalesce(new.raw_user_meta_data ->> 'profile_code', 'personal');
  IF v_code NOT IN ('personal', 'business') THEN v_code := 'personal'; END IF;
  -- Fallback por email: emails de demonstração com "negocio/business" viram perfil business
  IF (new.raw_user_meta_data ->> 'profile_code') IS NULL
     AND (new.email ILIKE '%negocio%' OR new.email ILIKE '%business%') THEN
    v_code := 'business';
  END IF;
  v_display := CASE WHEN v_code = 'business' THEN 'Negocio' ELSE 'Pessoal' END;

  SELECT id INTO v_profile_id FROM profiles WHERE code = v_code LIMIT 1;
  IF v_profile_id IS NULL THEN
    v_profile_id := gen_random_uuid();
    INSERT INTO profiles (id, code, display_name, is_active)
    VALUES (v_profile_id, v_code, v_display, TRUE);
  END IF;

  UPDATE auth.users
     SET raw_app_meta_data =
         coalesce(raw_app_meta_data, '{}'::jsonb)
         || jsonb_build_object('profile_id', v_profile_id::text, 'profile_code', v_code)
   WHERE id = new.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------- 3) RPC com 2 argumentos (profile derivado do JWT) ----------
CREATE OR REPLACE FUNCTION app.assign_category_atomic(p_transaction_id uuid, p_category_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app
AS $$
    SELECT app.assign_category_atomic(p_transaction_id, p_category_id, app.jwt_profile_id());
$$;

GRANT EXECUTE ON FUNCTION app.assign_category_atomic(uuid, uuid) TO authenticated;

-- Wrapper em public: o PostgREST do Supabase Cloud expõe somente o schema public,
-- e supabase.rpc('assign_category_atomic', ...) resolve a função nesse schema.
CREATE OR REPLACE FUNCTION public.assign_category_atomic(p_transaction_id uuid, p_category_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
  v_profile_id uuid;
BEGIN
  v_profile_id := app.jwt_profile_id();
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'perfil do token nao encontrado: crie o usuario apos o trigger handle_new_user (007)';
  END IF;
  RETURN app.assign_category_atomic(p_transaction_id, p_category_id, v_profile_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_category_atomic(uuid, uuid) TO authenticated;

-- ---------- 4) grants de escrita para o app (as políticas RLS de escrita seguem service_role-only;
--              o app escreve transações/categorias via RPC SECURITY DEFINER) ----------
GRANT INSERT, UPDATE, DELETE ON transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON reclassification_queue TO authenticated;
GRANT SELECT, INSERT ON category_assignment_audit TO authenticated;
GRANT USAGE ON SCHEMA app TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO authenticated;

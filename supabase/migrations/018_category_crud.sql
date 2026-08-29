-- ============================================================
-- 018_category_crud.sql
-- CRUD seguro de CATEGORIAS (CFG-P3A) — implementacao LOCAL (nao aplicar).
--
-- Regras de dominio (mantidas do schema 002/003/005/008):
--   * categories pertencem a UM perfil (profile_id NOT NULL; isolamento RLS
--     por app.jwt_profile_id() — categories_select_own);
--   * direction restrita: income/expense (transferencias nao recebem
--     categoria — app.assign_category_atomic bloqueia);
--   * parent deve ser do MESMO perfil e MESMA direction;
--   * anti-ciclo: trigger trg_category_cycle (003) + validacao propria aqui;
--   * colisao: UNIQUE (profile_id, direction, parent_id, normalized_name);
--   * arquivar NUNCA faz physical delete e NUNCA toca transactions;
--   * canonical_path e derivado da arvore (formato 'Raiz > Filho'), mantido
--     pelo proprio CRUD (mesmo padrao dos seeds/manutencoes anteriores).
--
-- Padrao do projeto: app.* = implementacao controlada (SECURITY DEFINER,
-- search_path fixo, perfil sempre do JWT); public.* = wrapper (INVOKER).
-- Escrita direta em categories permanece service_role-only (004/008).
-- ============================================================

BEGIN;

-- ---------- app.category_tree_path (canonical_path recursivo p/ no e descendentes) ----------
CREATE OR REPLACE FUNCTION app.category_refresh_path(p_category_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_parent uuid;
    v_parent_path text;
    v_name text;
    v_new_path text;
    v_child uuid;
BEGIN
    SELECT parent_id, display_name INTO v_parent, v_name
      FROM categories WHERE id = p_category_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'categoria nao encontrada';
    END IF;
    IF v_parent IS NULL THEN
        v_new_path := v_name;
    ELSE
        SELECT coalesce(canonical_path, display_name) INTO v_parent_path
          FROM categories WHERE id = v_parent;
        v_new_path := v_parent_path || ' > ' || v_name;
    END IF;
    UPDATE categories SET canonical_path = v_new_path, updated_at = now()
     WHERE id = p_category_id;
    FOR v_child IN SELECT id FROM categories WHERE parent_id = p_category_id ORDER BY display_name LOOP
        PERFORM app.category_refresh_path(v_child);
    END LOOP;
END;
$$;

-- ---------- app.category_create ----------
CREATE OR REPLACE FUNCTION app.category_create(
    p_display_name text,
    p_direction    text,
    p_parent_id    uuid DEFAULT NULL,
    p_source_name  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
    v_name    text;
    v_norm    text;
    v_source  text;
    v_parent_dir text;
    v_cat_id  uuid;
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    IF p_display_name IS NULL OR trim(p_display_name) = '' THEN
        RAISE EXCEPTION 'nome da categoria obrigatorio';
    END IF;
    IF p_direction IS NULL OR p_direction NOT IN ('income','expense') THEN
        RAISE EXCEPTION 'direcao invalida';
    END IF;
    v_name   := trim(p_display_name);
    v_norm   := app.normalize_description(v_name);
    v_source := coalesce(p_source_name, v_name);

    IF p_parent_id IS NOT NULL THEN
        SELECT direction INTO v_parent_dir FROM categories WHERE id = p_parent_id;
        IF v_parent_dir IS NULL THEN
            RAISE EXCEPTION 'categoria pai nao encontrada';
        END IF;
        IF v_parent_dir <> p_direction THEN
            RAISE EXCEPTION 'categoria de % nao pode ficar sob ancestral de %', p_direction, v_parent_dir;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM categories WHERE id = p_parent_id AND profile_id = v_profile) THEN
            RAISE EXCEPTION 'categoria pai pertence a outro perfil';
        END IF;
    END IF;

    INSERT INTO categories
        (id, profile_id, direction, parent_id, source_name, display_name,
         normalized_name, status, canonical_path, created_at, updated_at)
    VALUES
        (gen_random_uuid(), v_profile, p_direction, p_parent_id, v_source, v_name,
         v_norm, 'active', NULL, now(), now())
    RETURNING id INTO v_cat_id;

    PERFORM app.category_refresh_path(v_cat_id);

    RETURN jsonb_build_object(
        'category_id', v_cat_id,
        'display_name', v_name,
        'direction', p_direction,
        'parent_id', p_parent_id,
        'profile_id', v_profile
    );
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ja existe categoria com esse nome neste perfil e nivel (normalizado: %)', v_norm
        USING ERRCODE = 'P0001';
END;
$$;

-- ---------- app.category_update (rename + move; preserva id/transactions) ----------
CREATE OR REPLACE FUNCTION app.category_update(
    p_category_id   uuid,
    p_display_name  text,
    p_parent_id     uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
    v_dir     text;
    v_name    text;
    v_norm    text;
    v_ancestor uuid;
    v_parent_dir text;
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    SELECT profile_id, direction INTO v_profile, v_dir FROM categories WHERE id = p_category_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'categoria nao encontrada';
    END IF;
    IF v_profile <> app.jwt_profile_id() THEN
        RAISE EXCEPTION 'categoria pertence a outro perfil';
    END IF;
    IF p_display_name IS NULL OR trim(p_display_name) = '' THEN
        RAISE EXCEPTION 'nome da categoria obrigatorio';
    END IF;
    v_name := trim(p_display_name);
    v_norm := app.normalize_description(v_name);

    -- move: validacoes
    IF p_parent_id IS NOT NULL THEN
        IF p_parent_id = p_category_id THEN
            RAISE EXCEPTION 'categoria nao pode ser filha de si mesma';
        END IF;
        SELECT direction INTO v_parent_dir FROM categories WHERE id = p_parent_id;
        IF v_parent_dir IS NULL THEN
            RAISE EXCEPTION 'categoria pai nao encontrada';
        END IF;
        IF v_parent_dir <> v_dir THEN
            RAISE EXCEPTION 'categoria de % nao pode ficar sob ancestral de %', v_dir, v_parent_dir;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM categories WHERE id = p_parent_id AND profile_id = app.jwt_profile_id()) THEN
            RAISE EXCEPTION 'categoria pai pertence a outro perfil';
        END IF;
        -- anti-ciclo: o novo pai nao pode ser descendente do no
        v_ancestor := p_parent_id;
        WHILE v_ancestor IS NOT NULL LOOP
            IF v_ancestor = p_category_id THEN
                RAISE EXCEPTION 'movimentacao criaria ciclo na arvore de categorias';
            END IF;
            SELECT parent_id INTO v_ancestor FROM categories WHERE id = v_ancestor;
        END LOOP;
    END IF;

    UPDATE categories
       SET display_name    = v_name,
           normalized_name = v_norm,
           parent_id       = p_parent_id,
           updated_at      = now()
     WHERE id = p_category_id;

    PERFORM app.category_refresh_path(p_category_id);

    RETURN jsonb_build_object(
        'category_id', p_category_id,
        'display_name', v_name,
        'parent_id', p_parent_id
    );
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ja existe categoria com esse nome neste perfil e nivel (normalizado: %)', v_norm
        USING ERRCODE = 'P0001';
END;
$$;

-- ---------- app.category_set_archived (arquivar/reativar; sem physical delete) ----------
CREATE OR REPLACE FUNCTION app.category_set_archived(
    p_category_id uuid,
    p_archived    boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
    v_active_children integer;
    v_parent_archived boolean;
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM categories WHERE id = p_category_id AND profile_id = app.jwt_profile_id()) THEN
        RAISE EXCEPTION 'categoria nao encontrada neste perfil';
    END IF;

    IF p_archived THEN
        SELECT count(*) INTO v_active_children FROM categories
         WHERE parent_id = p_category_id AND status = 'active';
        IF v_active_children > 0 THEN
            RAISE EXCEPTION 'categoria possui subcategorias ativas; trate-as primeiro'
                USING ERRCODE = 'P0001';
        END IF;
        UPDATE categories SET status = 'archived', updated_at = now()
         WHERE id = p_category_id;
    ELSE
        SELECT EXISTS (
            SELECT 1 FROM categories c JOIN categories p ON p.id = c.parent_id
             WHERE c.id = p_category_id AND p.status = 'archived'
        ) INTO v_parent_archived;
        IF v_parent_archived THEN
            RAISE EXCEPTION 'categoria pai esta arquivada; reative-a antes'
                USING ERRCODE = 'P0001';
        END IF;
        UPDATE categories SET status = 'active', updated_at = now()
         WHERE id = p_category_id;
    END IF;

    RETURN jsonb_build_object(
        'category_id', p_category_id,
        'status', CASE WHEN p_archived THEN 'archived' ELSE 'active' END
    );
END;
$$;

-- ---------- wrappers public.* ----------
CREATE OR REPLACE FUNCTION public.category_create(
    p_display_name text,
    p_direction    text,
    p_parent_id    uuid DEFAULT NULL,
    p_source_name  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, app
AS $$
    SELECT app.category_create(p_display_name, p_direction, p_parent_id, p_source_name);
$$;

CREATE OR REPLACE FUNCTION public.category_update(
    p_category_id  uuid,
    p_display_name text,
    p_parent_id    uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, app
AS $$
    SELECT app.category_update(p_category_id, p_display_name, p_parent_id);
$$;

CREATE OR REPLACE FUNCTION public.category_set_archived(
    p_category_id uuid,
    p_archived    boolean
) RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, app
AS $$
    SELECT app.category_set_archived(p_category_id, p_archived);
$$;

-- ---------- grants (somente authenticated; helpers internos sem grant) ----------
GRANT EXECUTE ON FUNCTION app.category_create(text, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.category_update(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.category_set_archived(uuid, boolean) TO authenticated;

GRANT EXECUTE ON FUNCTION public.category_create(text, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.category_update(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.category_set_archived(uuid, boolean) TO authenticated;

COMMIT;
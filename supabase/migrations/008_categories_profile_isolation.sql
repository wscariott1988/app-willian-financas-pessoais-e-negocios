-- 008_categories_profile_isolation.sql
-- Isolamento de categorias por perfil (auditoria 1.2A.4B.2).
--
-- As categorias NÃO são um catálogo global: cada categoria pertence
-- exatamente a um perfil (categories.profile_id é NOT NULL e identifica
-- o perfil proprietário). A policy anterior (categories_select_auth) permitia
-- a qualquer usuário autenticado ler TODAS as categorias, misturando
-- Pessoal e Negócio na interface.
--
-- Esta migration restringe a leitura ao perfil do JWT (app.jwt_profile_id()),
-- mantendo o acesso do service_role. A filtragem feita no frontend
-- (perfil + direção + status ativo) é apenas defesa adicional; o
-- isolamento real acontece na policy. Quando app.jwt_profile_id() está
-- ausente, a condição avalia NULL e a linha é negada (fail-closed).
--
-- Não altera linhas, IDs ou hierarquia; apenas policies RLS.

DROP POLICY IF EXISTS categories_select_auth ON categories;

CREATE POLICY categories_select_own ON categories FOR SELECT
    USING (
        app.jwt_role() = 'service_role'
        OR categories.profile_id = app.jwt_profile_id()
    );

-- As policies de escrita existentes (categories_write_service) e os grants
-- permanecem inalterados.

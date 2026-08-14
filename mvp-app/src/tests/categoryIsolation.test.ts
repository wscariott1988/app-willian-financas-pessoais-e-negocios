import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function readRepo(rel: string): string {
  return readFileSync(resolve(here, '..', '..', '..', rel), 'utf8');
}

describe('migration 008 — isolamento de categorias por perfil (1.2A.4B.2)', () => {
  const mig = readRepo('supabase/migrations/008_categories_profile_isolation.sql');

  it('12) remove a policy ampla categories_select_auth', () => {
    expect(mig).toContain('DROP POLICY IF EXISTS categories_select_auth ON categories');
  });

  it('13) cria policy SELECT restrita a app.jwt_profile_id()', () => {
    expect(mig).toContain('CREATE POLICY categories_select_own ON categories FOR SELECT');
    expect(mig).toContain('categories.profile_id = app.jwt_profile_id()');
  });

  it('14) preserva o acesso do service_role', () => {
    expect(mig).toContain("app.jwt_role() = 'service_role'");
    expect(mig).toContain('OR categories.profile_id = app.jwt_profile_id()');
  });

  it('15) não contém UPDATE, INSERT, DELETE ou alteração de linhas', () => {
    expect(mig).not.toMatch(/\bUPDATE\b/);
    expect(mig).not.toMatch(/\bINSERT\b/);
    expect(mig).not.toMatch(/\bDELETE\b/);
    expect(mig).not.toMatch(/\bALTER TABLE\b/);
    expect(mig).not.toMatch(/VALUES\s*\(/);
  });

  it('a policy é fail-closed quando o perfil do JWT está ausente', () => {
    // profile_id = NULL nunca é verdadeiro -> linha negada
    expect(mig).toContain('profile_id = app.jwt_profile_id()');
  });
});

describe('RPC assign_category_atomic — validações cruzadas existentes (1.2A.4B.2)', () => {
  const fn = readRepo('supabase/migrations/005_functions.sql');
  const cloud = readRepo('supabase/cloud/007_cloud_compat.sql');

  it('16) transação pertence ao perfil informado', () => {
    expect(fn).toContain('IF v_tx_profile <> p_profile_id THEN');
  });

  it('16) categoria pertence ao mesmo perfil', () => {
    expect(fn).toContain('IF v_cat_profile <> p_profile_id THEN');
  });

  it('16) categoria está ativa', () => {
    expect(fn).toContain("IF v_cat_status <> 'active' THEN");
  });

  it('16) direção é compatível', () => {
    expect(fn).toContain('IF v_cat_direction <> v_tx_kind THEN');
  });

  it('16) SECURITY DEFINER com search_path fixo e grants mínimos', () => {
    expect(fn).toContain('SECURITY DEFINER');
    expect(fn).toContain('SET search_path = public, app');
    expect(fn).toContain('GRANT EXECUTE ON FUNCTION app.assign_category_atomic(uuid, uuid, uuid) TO authenticated');
  });

  it('16) o wrapper do Cloud deriva o perfil do JWT (app.jwt_profile_id)', () => {
    expect(cloud).toContain('app.jwt_profile_id()');
    expect(cloud).toContain('v_profile_id IS NULL');
  });
});

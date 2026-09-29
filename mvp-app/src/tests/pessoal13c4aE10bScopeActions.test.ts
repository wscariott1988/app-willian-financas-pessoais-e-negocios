// PESSOAL-13C4A-E10B — escopos de ação em recorrências e parcelamentos.
//
// Cobre duas camadas sem tocar em banco:
//  1) contrato puro do cliente (lib/seriesScope.ts) — escopo, impacto,
//     confirmações e tri-estado de campos;
//  2) contrato estático da migration 027 — porque NÃO há PostgreSQL local
//     (proibido conectar) e a aplicação está bloqueada por backup (BL-4).
//     As asserções leem o SQL e exigem que os defeitos semânticos do catálogo
//     implantado NÃO reapareçam: status propagado, is_edited pulado,
//     before_state depois da mutação e valor de parcela em lote.
//
//     Sobre os wrappers public.*: eles EXISTEM no catálogo implantado
//     (E10A3_B13 reporta existe_no_banco=true para os cinco). B03
//     (wrappers_public_dependentes) e B12 (objetos_public_por_nome_suspeito)
//     não são inventários de pg_proc e não provam ausência. O defeito real é
//     ACL: o 021 nunca aplicou REVOKE ... FROM PUBLIC nos wrappers, então anon
//     herdava EXECUTE das RPCs mutáveis. Estes testes exigem o ACL correto.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  buildSeriesEditArgs,
  buildSeriesDeleteArgs,
  buildImpactArgs,
  normalizeSeriesImpact,
  requiredConfirms,
  confirmsSatisfied,
  impactSummaryLines,
  impactWarnings,
  resolveFieldAction,
  seriesAmountAllowed,
  SERIES_FIELD_ACTIONS,
  type SeriesScopeImpact,
} from '../lib/seriesScope';
import type { SeriesScope } from '../lib/series';

const ROOT = resolve(__dirname, '../../..');
const sql = readFileSync(resolve(ROOT, 'supabase/migrations/027_series_scope_actions.sql'), 'utf8');
const editorSrc = readFileSync(resolve(ROOT, 'mvp-app/src/components/TransactionEditor.tsx'), 'utf8');
const delSrc = readFileSync(resolve(ROOT, 'mvp-app/src/components/DeleteConfirmation.tsx'), 'utf8');
const seriesScopeSrc = readFileSync(resolve(ROOT, 'mvp-app/src/lib/seriesScope.ts'), 'utf8');

const SCOPES: SeriesScope[] = ['this', 'this_and_next', 'whole'];

function impact(over: Partial<SeriesScopeImpact> = {}): SeriesScopeImpact {
  return normalizeSeriesImpact({
    series_id: 's-1',
    kind: 'recurring',
    scope: 'this_and_next',
    from_occurrence: 4,
    total_no_escopo: 9,
    ativas: 9,
    ja_excluidas: 0,
    passadas: 3,
    futuras: 6,
    pagas: 2,
    posted: 2,
    pending: 4,
    scheduled: 3,
    editadas: 1,
    indices_editados: [7],
    indices_ja_excluidos: [],
    primeira_data: '2026-01-10',
    ultima_data: '2026-09-10',
    requer_confirmacao_passado: true,
    requer_confirmacao_pago: true,
    requer_confirmacao_editada: true,
    valor_coletivo_bloqueado: false,
    status_propagado: false,
    ...over,
  })!;
}

const payload = {
  description: 'Mercado',
  amount: '49.84',
  account_id: 'acc-1',
  category_id: 'cat-1',
  status: 'posted',
  memo: null,
};
const recurring = { series_id: 's-1', occurrence_index: 4, total: 12, kind: 'recurring' };
const installment = { series_id: 's-1', occurrence_index: 4, total: 12, kind: 'installment' };

describe('E10B — escopo é calculado pelo escopo, nunca adivinhado', () => {
  it('this: p_from_occurrence = índice da ocorrência, sem alcance antes', () => {
    const a = buildSeriesEditArgs(recurring, 'this', payload, 'ts', false);
    expect(a.p_scope).toBe('this');
    expect(a.p_from_occurrence).toBe(4);
  });

  it('this_and_next e whole: mesma âncora, escopo decide o alcance no backend', () => {
    expect(buildSeriesEditArgs(recurring, 'this_and_next', payload, 'ts', false).p_from_occurrence).toBe(4);
    expect(buildSeriesEditArgs(recurring, 'whole', payload, 'ts', false).p_from_occurrence).toBe(4);
    // a âncora viaja sempre; é o p_scope que inclui passado
    expect(buildImpactArgs('s-1', 'this', 4).p_from_occurrence).toBe(4);
    expect(buildImpactArgs('s-1', 'this_and_next', 4).p_from_occurrence).toBe(4);
    expect(buildImpactArgs('s-1', 'whole', 4).p_from_occurrence).toBeNull();
  });
});

describe('E10B — status individual nunca é propagado em lote', () => {
  it('p_status = null em this_and_next e whole', () => {
    for (const scope of ['this_and_next', 'whole'] as SeriesScope[]) {
      expect(buildSeriesEditArgs(recurring, scope, payload, 'ts', false).p_status).toBeNull();
    }
  });

  it('p_status viaja apenas em this', () => {
    expect(buildSeriesEditArgs(recurring, 'this', payload, 'ts', false).p_status).toBe('posted');
  });

  it('migration 027: status só muda quando p_scope = this (coalesce rejeitado)', () => {
    // defeito 1 do catálogo: coalesce(p_status, status) espalhava status
    expect(sql).toMatch(/status\s*=\s*CASE WHEN p_scope = 'this' THEN coalesce\(p_status, status\) ELSE status END/i);
    // e o status nunca entra no UPDATE fora desse CASE
    expect(sql).not.toMatch(/SET[\s\S]{0,400}?status\s*=\s*coalesce\(p_status, status\)\s*,/i);
  });

  it('migration 027: rejeita p_status fora de this', () => {
    expect(sql).toMatch(/p_scope\s*<>\s*'this'[\s\S]{0,400}?p_status[\s\S]{0,200}?status/i);
  });
});

describe('E10B — is_edited entra no escopo, nunca é pulado em silêncio', () => {
  it('contagem de editedas aparece na prévia e nas três confirmações', () => {
    const imp = impact({ editadas: 2, indices_editados: [4, 7] });
    expect(requiredConfirms(imp).edited).toBe(true);
    expect(impactWarnings(imp, 'edit')).toHaveLength(3);
    const linhas = impactSummaryLines(imp, 'edit').join(' ');
    expect(linhas).toMatch(/editadas individualmente/);
    expect(linhas).toMatch(/4, 7/);
  });

  it('migration 027: nenhum CONTINUE/SKIP sobre is_edited', () => {
    expect(sql).not.toMatch(/CONTINUE\s+WHEN[\s\S]{0,60}is_edited/i);
    expect(sql).not.toMatch(/NOT\s+v_oc\.is_edited/i);
    // e o comentário do código deixa explícito que editedas entram no conjunto
    expect(sql).toMatch(/is_edited não pula/i);
  });

  it('UI: existe confirmação específica para editadas na edição e na exclusão', () => {
    expect(editorSrc).toContain('Confirmo que desejo alterar também ocorrências que já foram editadas individualmente');
    expect(delSrc).toContain('Confirmo que desejo excluir também ocorrências editadas individualmente');
  });
});

describe('E10B — confirmação forte de passado/posted antes de operar em lote', () => {
  it('exige apenas as confirmações que a prévia indica', () => {
    const soFuturas = impact({ scope: 'whole', passadas: 0, pagas: 0, editadas: 0 });
    expect(requiredConfirms(soFuturas)).toEqual({ past: false, posted: false, edited: false });
    expect(confirmsSatisfied(soFuturas, { past: false, posted: false, edited: false })).toBe(true);
  });

  it('bloqueia enquanto faltar qualquer confirmação exigida', () => {
    const imp = impact();
    expect(confirmsSatisfied(imp, { past: true, posted: true, edited: false })).toBe(false);
    expect(confirmsSatisfied(imp, { past: false, posted: true, edited: true })).toBe(false);
    expect(confirmsSatisfied(imp, { past: true, posted: true, edited: true })).toBe(true);
  });

  it('sem prévia a operação coletiva fica bloqueada (a UI nunca chuta contagem)', () => {
    expect(normalizeSeriesImpact(null)).toBeNull();
    expect(normalizeSeriesImpact({ scope: 'whole' })).toBeNull();
    expect(requiredConfirms(null)).toEqual({ past: false, posted: false, edited: false });
    expect(impactSummaryLines(null, 'edit')).toEqual([]);
    expect(impactSummaryLines(impact({}), 'edit').length).toBeGreaterThan(0);
  });

  it('a contagem anunciada é a de ATIVAS, que é o que os laços do backend tocam', () => {
    // Regressão: a prévia anunciava total_no_escopo, mas os laços de
    // mutation filtram transactions.deleted_at IS NULL. Com ocorrências já
    // excluídas no intervalo, o número prometido era maior do que o
    // realmente alterado/excluído. 42/36 são valores que não aparecem em
    // nenhum outro campo, para detectar vazamento do total com precisão.
    const imp = impact({ total_no_escopo: 42, ativas: 6, ja_excluidas: 36 });
    for (const action of ['edit', 'delete'] as const) {
      const linhas = impactSummaryLines(imp, action);
      expect(linhas[0], `${action}: 1a linha`).toMatch(/^6 ocorr/);
      expect(linhas[0], `${action}: 1a linha`).not.toMatch(/42/);
      // o total bruto continua disponível, mas como diagnóstico explícito
      expect(linhas.join(' ')).toMatch(/Total no escopo: 42/);
      expect(linhas.join(' ')).toMatch(/36 .*exclu/);
    }
    // avisos e confirmações também nunca falam pelo total
    expect(impactWarnings(imp, 'delete').join(' ')).not.toMatch(/42/);
    expect(impactWarnings(imp, 'edit').join(' ')).not.toMatch(/42/);
  });

  it('p_confirm_* vem SÓ do aceite explícito, em todos os escopos (inclusive this)', () => {
    // nada marcado => tudo false, mesmo com prévia exigindo (E10F gate 3.5)
    const none = buildSeriesEditArgs(recurring, 'this', payload, 'ts', false);
    expect(none.p_confirm_past).toBe(false);
    expect(none.p_confirm_posted).toBe(false);
    expect(none.p_confirm_edited).toBe(false);

    const c = { past: true, posted: true, edited: true };
    for (const scope of ['this', 'this_and_next', 'whole'] as SeriesScope[]) {
      const a = buildSeriesEditArgs(recurring, scope, payload, 'ts', false, { confirms: c });
      expect(a.p_confirm_past && a.p_confirm_posted && a.p_confirm_edited).toBe(true);
    }
  });

  it('migration 027: exige as três confirmações em escopo coletivo', () => {
    expect(sql).toMatch(/p_confirm_past/);
    expect(sql).toMatch(/p_confirm_posted/);
    expect(sql).toMatch(/p_confirm_edited/);
  });
});

describe('E10B — valor de parcela: liberado em this, bloqueado em lote', () => {
  it('seriesAmountAllowed reflecte a regra', () => {
    expect(seriesAmountAllowed('installment', 'this')).toBe(true);
    expect(seriesAmountAllowed('installment', 'this_and_next')).toBe(false);
    expect(seriesAmountAllowed('installment', 'whole')).toBe(false);
    // recorrente pode editar o valor coletivamente
    expect(seriesAmountAllowed('recurring', 'whole')).toBe(true);
    expect(seriesAmountAllowed('recurring', 'this_and_next')).toBe(true);
  });

  it('installment: p_amount = null nos dois escopos coletivos', () => {
    for (const scope of ['this_and_next', 'whole'] as SeriesScope[]) {
      expect(buildSeriesEditArgs(installment, scope, payload, 'ts', false).p_amount).toBeNull();
    }
  });

  it('installment: p_amount enviado em this; recorrente envia em todos', () => {
    expect(buildSeriesEditArgs(installment, 'this', payload, 'ts', false).p_amount).toBe('49.84');
    for (const scope of SCOPES) {
      expect(buildSeriesEditArgs(recurring, scope, payload, 'ts', false).p_amount).toBe('49.84');
    }
  });

  it('migration 027: barra valor em lote de parcelamento com aviso explícito', () => {
    expect(sql).toMatch(/installment[\s\S]{0,200}?p_amount[\s\S]{0,160}?i/i);
    expect(sql).toMatch(/valor[\s\S]{0,80}?parcela/i);
  });
});

describe('E10B — categoria/memo: tri-estado explícito (nenhum NULL ambíguo)', () => {
  it('resolveFieldAction: igual=preserve, vazio=clear, diferente=set', () => {
    expect(resolveFieldAction('cat-1', 'cat-1')).toEqual({ action: 'preserve', value: null });
    expect(resolveFieldAction('nota', '')).toEqual({ action: 'clear', value: null });
    expect(resolveFieldAction(null, 'cat-2')).toEqual({ action: 'set', value: 'cat-2' });
    expect(resolveFieldAction(undefined, undefined)).toEqual({ action: 'preserve', value: null });
  });

  it('as três ações existem e o default é preserve (sem original não há set espúrio)', () => {
    expect([...SERIES_FIELD_ACTIONS]).toEqual(['preserve', 'set', 'clear']);
    const a = buildSeriesEditArgs(recurring, 'whole', payload, 'ts', false, {
      original: { category_id: 'cat-1', memo: null },
    });
    expect(a.p_category_action).toBe('preserve');
    expect(a.p_memo_action).toBe('preserve');
  });

  it('clear limpa de verdade; set carrega o valor; preserve não envia valor', () => {
    const clear = buildSeriesEditArgs(recurring, 'whole', { ...payload, category_id: '', memo: '' }, 'ts', false, {
      original: { category_id: 'cat-1', memo: 'nota' },
    });
    expect(clear.p_category_action).toBe('clear');
    expect(clear.p_category_id).toBeNull();
    expect(clear.p_memo_action).toBe('clear');
    expect(clear.p_memo).toBeNull();

    const set = buildSeriesEditArgs(recurring, 'whole', { ...payload, category_id: 'cat-9', memo: 'nova' }, 'ts', false, {
      original: { category_id: 'cat-1', memo: null },
    });
    expect(set.p_category_action).toBe('set');
    expect(set.p_category_id).toBe('cat-9');
    expect(set.p_memo_action).toBe('set');
    expect(set.p_memo).toBe('nova');
  });

  it('migration 027: categoria/memo com *_action e rejeição de set sem valor', () => {
    expect(sql).toMatch(/p_category_action\s+text\s+DEFAULT 'preserve'/);
    expect(sql).toMatch(/p_memo_action\s+text\s+DEFAULT 'preserve'/);
    expect(sql).toMatch(/WHEN p_category_action\s*=\s*'set'\s+THEN p_category_id/i);
    expect(sql).toMatch(/WHEN p_memo_action\s*=\s*'clear'\s+THEN NULL/i);
  });
});

describe('E10B — soft delete reversível, nunca hard delete', () => {
  it('migration 027 só mexe em deleted_at; nenhum DELETE de transactions', () => {
    expect(sql).not.toMatch(/DELETE\s+FROM\s+transactions/i);
    expect(sql).toMatch(/SET deleted_at = now\(\)/i);
    expect(sql).toMatch(/AND deleted_at IS NULL/i);
  });

  it('a UI promete reversibilidade em vez de "não pode ser desfeita"', () => {
    expect(delSrc).not.toContain('Esta acao nao pode ser desfeita');
    expect(delSrc).toMatch(/revertida/i);
  });

  it('laços de mutação só tocam ocorrências ativas (não mexe em já excluídas)', () => {
    // a função de IMPACTO conta as já excluídas de propósito (informar a prévia);
    // quem MUTA é que precisa filtrar.
    for (const fname of ['app.transaction_series_edit', 'app.transaction_series_delete']) {
      const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${fname}(`);
      expect(start).toBeGreaterThan(-1);
      const end = sql.indexOf('\n$function$;', start);
      const body = sql.slice(start, end);
      const loops = body.match(/JOIN transactions t ON t\.id = o\.transaction_id[\s\S]*?ORDER BY o\.occurrence_index/g) ?? [];
      expect(loops.length).toBeGreaterThanOrEqual(1);
      for (const l of loops) expect(l).toMatch(/AND t\.deleted_at IS NULL/);
    }
  });
});

describe('E10B — concorrência otimista e atomicidade', () => {
  it('edit e delete enviam o updated_at da série', () => {
    const info = { ...recurring, series_updated_at: 'serie-ts' };
    expect(buildSeriesEditArgs(info, 'whole', payload, 'tx-ts', false).p_expected_updated_at).toBe('serie-ts');
    expect(buildSeriesDeleteArgs(info, 'whole', 'tx-ts', 'serie-ts').p_expected_updated_at).toBe('serie-ts');
  });

  it('nunca usa o updated_at da TRANSAÇÃO como token de série', () => {
    // Regressão: havia um fallback legado para expectedUpdatedAt (o
    // updated_at da transação). Como a 027 compara contra
    // transaction_series.updated_at, isso comparava relógios de domínios
    // diferentes e gerava CONFLITO espúrio. Ausência vira null, e o backend
    // recusa explicitamente.
    const args = buildSeriesDeleteArgs(recurring, 'this', 'tx-ts', null);
    expect(args.p_expected_updated_at).toBeNull();
    const edit = buildSeriesEditArgs(recurring, 'this', payload, 'tx-ts', false);
    expect(edit.p_expected_updated_at).toBeNull();
    for (const v of [args.p_expected_updated_at, edit.p_expected_updated_at]) {
      expect(v).not.toBe('tx-ts');
    }
  });

  it('o token explícito da série tem prioridade sobre seriesInfo', () => {
    const info = { ...recurring, series_updated_at: 'info-ts' };
    expect(buildSeriesDeleteArgs(info, 'this', 'tx-ts', 'opts-ts').p_expected_updated_at).toBe('opts-ts');
    expect(buildSeriesEditArgs(info, 'this', payload, 'tx-ts', false, { seriesUpdatedAt: 'opts-ts' }).p_expected_updated_at).toBe('opts-ts');
  });

  it('migration 027: bloqueia a série com FOR UPDATE e compara updated_at', () => {
    expect(sql).toMatch(/FOR UPDATE/i);
    expect(sql).toMatch(/p_expected_updated_at/);
    expect(sql).toMatch(/CONFLITO|CONFLICT/i);
  });

  it('before_state é capturado ANTES do UPDATE de cada transação', () => {
    const idxBefore = sql.indexOf('app.tx_state_jsonb');
    const idxUpdate = sql.indexOf('UPDATE transactions');
    expect(idxBefore).toBeGreaterThan(-1);
    expect(idxBefore).toBeLessThan(idxUpdate);
  });

  it('audita delete e update com changed_by do JWT', () => {
    expect(sql).toMatch(/INSERT INTO transaction_audit/i);
    expect(sql).toMatch(/'delete'/);
    expect(sql).toMatch(/'update'/);
    expect(sql).toMatch(/v_sub/);
  });
});

describe('E10B — isolamento de perfil (Pessoal não toca Negócio)', () => {
  it('impacto, edição e exclusão filtram por profile_id do JWT', () => {
    const matches = sql.match(/AND t\.profile_id = v_profile/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
    expect(sql).toMatch(/v_profile\s*:=\s*app\.jwt_profile_id\(\)/);
  });

  it('a série alvo é filtrada por profile_id no SELECT com FOR UPDATE', () => {
    expect(sql).toMatch(/FROM transaction_series[\s\S]{0,200}?profile_id = v_profile/i);
  });
});

describe('E10B — exposição mínima: as 5 wrappers public só para authenticated', () => {
  // Os wrappers public.* de série EXISTEM no catálogo implantado (B13,
  // existe_no_banco=true). A 027 não pode recriá-los às cegas nem removê-los.
  const ALL_PUBLIC = [
    'public.series_scope_impact',
    'public.transaction_series_create',
    'public.transaction_series_delete',
    'public.transaction_series_edit',
    'public.transaction_series_materialize',
    'public.transaction_series_preview',
  ];

  it('ACL correto para as 5 wrappers + a nova de impacto', () => {
    const revokes = sql.match(/REVOKE ALL ON FUNCTION (app|public)\.[\s\S]*?FROM PUBLIC, anon;/g) ?? [];
    const grants = sql.match(/GRANT EXECUTE ON FUNCTION (app|public)\.[\s\S]*?TO authenticated;/g) ?? [];
    // 3 app.* + 6 public.* (impact, create, delete, edit, materialize, preview)
    expect(revokes.length).toBe(9);
    expect(grants.length).toBe(9);
    expect(sql).not.toMatch(/TO anon;/);
    expect(sql).not.toMatch(/TO service_role;/);
    for (const fn of ALL_PUBLIC) {
      const name = fn.slice('public.'.length);
      expect(sql, `falta REVOKE PUBLIC/anon em ${fn}`).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION ${fn.replace('.', '\\.')}\\([\\s\\S]*?\\) FROM PUBLIC, anon;`),
      );
      expect(sql, `falta GRANT authenticated em ${fn}`).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION ${fn.replace('.', '\\.')}\\([\\s\\S]*?\\) TO authenticated;`),
      );
      expect(name).toBeTruthy();
    }
  });

  it('create, preview e materialize NÃO são dropadas nem recriadas (corpo preservado)', () => {
    // Regressão do 7ed0f94: havia um DROP destrutivo em
    // public.transaction_series_preview que nunca era recriado, o que
    // removeria a RPC de prévia de criação de série.
    for (const fn of ['public.transaction_series_create', 'public.transaction_series_preview', 'public.transaction_series_materialize']) {
      expect(sql, `${fn} não pode ser DROPada`).not.toMatch(new RegExp(`DROP FUNCTION[^;]*${fn.replace('.', '\\.')}\\(`));
      expect(sql, `${fn} não precisa ser recriada`).not.toMatch(
        new RegExp(`CREATE (OR REPLACE )?FUNCTION ${fn.replace('.', '\\.')}\\(`),
      );
    }
  });

  it('os únicos DROP usam a assinatura exata implantada e são justificados', () => {
    const drops = sql.match(/DROP FUNCTION IF EXISTS [\s\S]*?;/g) ?? [];
    // 2 wrappers public (delete, edit) + 2 app.* (delete, edit) + 1 app.* defensivo
    expect(drops.length).toBe(5);
    for (const d of drops) expect(d).toMatch(/IF EXISTS/);
    // a justificativa da aridade está no SQL
    expect(sql).toMatch(/ARIDADE muda/);
    expect(sql).toMatch(/CREATE OR REPLACE não troca/);
    // nada de CASCADE em qualquer DROP FUNCTION: a ordem public -> app preserva as dependências
    expect(sql).not.toMatch(/DROP FUNCTION[^;]*CASCADE/i);
    // e a ordem está correta: todo wrapper public.* é removido antes do app.* correspondente
    const ordem = [...sql.matchAll(/DROP FUNCTION IF EXISTS (public|app)\./g)].map((m) => m[1]);
    expect(ordem).toEqual(['public', 'public', 'app', 'app', 'app']);
  });

  it('edit e delete mudam de aridade, então o DROP é necessário e o frontend acompanha', () => {
    // 11 -> 15 (edit) e 5 -> 7 (delete): aridade nova, sem overload órfão
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.transaction_series_edit\(uuid, integer, text, timestamptz, text, numeric, uuid, uuid, text, text, boolean\);/);
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.transaction_series_delete\(uuid, integer, text, timestamptz, boolean\);/);
    // o frontend envia exatamente a assinatura nova, via helper compartilhado
    const args = buildSeriesEditArgs(recurring, 'whole', payload, 'ts', false, { confirms: { past: true, posted: true, edited: true } });
    for (const k of Object.keys(args)) {
      expect(sql, `parâmetro ${k} sem par no SQL`).toMatch(new RegExp(`\\b${k}\\b`));
    }
  });

  it('a função de impacto tem wrapper public acessível pelo PostgREST', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.series_scope_impact\(/);
    expect(editorSrc).toContain("rpc('series_scope_impact'");
    expect(delSrc).toContain("rpc('series_scope_impact'");
    const i = sql.indexOf('CREATE OR REPLACE FUNCTION public.series_scope_impact(');
    const w = sql.slice(i, sql.indexOf('$$;', i));
    expect(w).toMatch(/SECURITY INVOKER/);
    expect(w).toMatch(/app\.series_scope_impact\(p_series_id, p_from_occurrence, p_scope\)/);
  });

  it('wrappers recriados são INVOKER com search_path fixo', () => {
    const wrappers = sql.match(/CREATE OR REPLACE FUNCTION public\.[\s\S]*?\$\$;/g) ?? [];
    expect(wrappers.length).toBe(3);
    for (const w of wrappers) {
      expect(w).toMatch(/SECURITY INVOKER/);
      expect(w).not.toMatch(/SECURITY DEFINER/);
      expect(w).toMatch(/SET search_path TO 'public', 'app'/);
    }
  });

  it('as funções app que fazem o trabalho real são SECURITY DEFINER', () => {
    // a de impacto é STABLE (read-only); as mutantes são VOLATILE por padrão
    // \r?\n porque o arquivo pode ser lido com CRLF ou LF dependendo de como o
    // checkout materializou a migration; a asserção é sobre o conteúdo, não
    // sobre a quebra de linha.
    expect(sql).toMatch(/FUNCTION app\.series_scope_impact[\s\S]*?LANGUAGE plpgsql\r?\nSTABLE\r?\nSECURITY DEFINER/);
    const mut = sql.match(/FUNCTION app\.transaction_series_(edit|delete)[\s\S]*?LANGUAGE plpgsql\r?\nSECURITY DEFINER/g) ?? [];
    expect(mut.length).toBe(2);
  });

  it('helpers internos de app.* não recebem GRANT', () => {
    for (const h of ['assert_account_for_profile', 'resolve_category_for_profile', 'normalize_description', 'tx_state_jsonb']) {
      expect(sql).not.toMatch(new RegExp(`GRANT[^;]*${h}`));
    }
  });
});

describe('E10B — não mexe no que é estrutural da série', () => {
  it('migration 027 não altera data, frequência, quantidade nem índice da ocorrência', () => {
    const updates = sql.match(/UPDATE transaction_series_occurrences[\s\S]*?;/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u).not.toMatch(/occurred_on\s*=/i);
      expect(u).not.toMatch(/occurrence_index\s*=/i);
    }
    const serUpdates = sql.match(/UPDATE transaction_series\b[\s\S]*?;/g) ?? [];
    for (const u of serUpdates) {
      expect(u).not.toMatch(/frequency\s*=/i);
      expect(u).not.toMatch(/total_occurrences\s*=/i);
      expect(u).not.toMatch(/starts_on\s*=/i);
    }
  });

  it('UI: o caminho de EDIÇÃO de série não mexe em datas, frequência nem quantidade', () => {
    // a criação de série (entryType) legitimamente usa p_total_occurrences/
    // p_frequency; o que é proibido é o caminho de edição em escopo.
    const from = editorSrc.indexOf("supabase.rpc('transaction_series_edit'");
    const to = editorSrc.indexOf("supabase.rpc('transaction_update'");
    const editCall = editorSrc.slice(from, to);
    expect(from).toBeGreaterThan(-1);
    expect(editCall).not.toMatch(/p_occurred_on|p_total_occurrences|p_frequency|p_starts_on/);
  });
});

describe('E10B — exclusão pela DeleteConfirmation usa o mesmo escopo', () => {
  it('oferece os três escopos e chama o RPC de série quando há série', () => {
    expect(delSrc).toContain('delete-series-scope');
    expect(delSrc).toContain("supabase.rpc('transaction_series_delete'");
    expect(delSrc).toContain("supabase.rpc('transaction_delete'");
    expect(delSrc).toContain('SERIES_SCOPE_LABELS');
  });

  it('botão de excluir fica bloqueado enquanto faltar confirmação', () => {
    expect(delSrc).toMatch(/disabled=\{loadingDetail \|\| deleting \|\| !expectedUpdatedAt \|\| deleteBlocked\}/);
  });
});

describe('E10B — a prévia de impacto é sempre consultada no backend', () => {
  it('a edição e a exclusão chamam series_scope_impact (read-only)', () => {
    expect(editorSrc).toContain("rpc('series_scope_impact'");
    expect(delSrc).toContain("rpc('series_scope_impact'");
  });

  it('a impactagem acontece em efeito, sem write', () => {
    const effects = editorSrc.match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[/g) ?? [];
    const withImpact = effects.filter((e) => e.includes('series_scope_impact'));
    expect(withImpact.length).toBe(1);
    for (const e of withImpact) {
      expect(e).not.toMatch(/\.insert\(|\.update\(|\.delete\(|transaction_series_edit|transaction_series_delete/);
    }
  });
});

describe('E10B — falha e corrida de detecção não viram silêncio', () => {
  it('a prévia de impacto é sempre consultada no backend', () => {
    expect(editorSrc).toContain("rpc('series_scope_impact'");
    expect(delSrc).toContain("rpc('series_scope_impact'");
  });

  it('erro da prévia é renderizado, não engolido pelo gate de render', () => {
    // Regressão: o bloco só abria com (impactLoading || impact), então uma
    // falha de RPC deixava impact=null e a mensagem de erro nunca aparecia.
    expect(editorSrc).toContain('(impactLoading || impact || impactError)');
    expect(delSrc).toContain('(impactLoading || impact || impactError)');
    // e o texto que aparecia no lugar ("nunca altera anteriores") some se houver erro
    expect(editorSrc).toContain('!impact && !impactLoading && !impactError');
  });

  it('o erro da exclusão tem mensagem própria e orienta o usuário', () => {
    expect(delSrc).toContain('delete-series-impact-error');
    expect(delSrc).toMatch(/setImpactError\(rpcError \? String\(rpcError\.message \|\| rpcError\)/);
  });

  it('salvar/excluir espera a detecção de série para não perder o escopo', () => {
    // Regressão: seriesInfo começa null, então salvar/excluir dentro da janela
    // de detecção caía no caminho genérico (transaction_update/transaction_delete)
    // e o escopo da série era perdido sem erro.
    expect(editorSrc).toMatch(/const \[seriesLoading, setSeriesLoading\] = useState\(false\)/);
    expect(editorSrc).toMatch(/!seriesLoading &&/);
    expect(delSrc).toMatch(/const \[detectingSeries, setDetectingSeries\] = useState\(false\)/);
    expect(delSrc).toMatch(/const seriesLoading = detectingSeries/);
    expect(delSrc).toMatch(/const deleteBlocked =\s*\n?\s*seriesLoading \|\|/);
  });

  it('a detecção sempre resolve o flag, inclusive no caminho de erro', () => {
    for (const src of [editorSrc, delSrc]) {
      const effects = src.match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[/g) ?? [];
      const det = effects.filter((e) => e.includes('transaction_series_occurrences'));
      expect(det.length).toBe(1);
      for (const e of det) {
        // todo rejection handler (`, () => {` ou `.then(undefined, () => {`)
        // também limpa o loading, senão o botão fica travado para sempre
        expect(e, 'flag de loading nunca resolvido').toMatch(
          /(\}\,|\.then\(undefined,)\s*\(\)\s*=>\s*\{[\s\S]*?set\w+\(false\)/,
        );
      }
    }
  });

  it('impactError também bloqueia a exclusão, em todos os escopos', () => {
    // E10F (gate 3.5): o bloqueio vale também em 'this'; a prévia de impacto é
    // pré-requisito das confirmações em qualquer escopo.
    expect(delSrc).toMatch(/deleteBlocked =\s*\n?\s*seriesLoading \|\| \(!!seriesInfo && \(impactLoading \|\| !!impactError \|\| !impact \|\| !impactReady\)\)/);
  });
});

describe('E10B — concorrência otimista não pode ser desligada por omissão', () => {
  it('nenhum guard aceita "p_expected_updated_at IS NOT NULL AND ..."', () => {
    // Regressão: com DEFAULT NULL, esse padrão transformava a omissão do
    // parâmetro em "sem verificação", sobrescrevendo edição concorrente.
    expect(sql).not.toMatch(/p_expected_updated_at IS NOT NULL\s*\n\s*AND abs/);
  });

  it('edit e delete rejeitam explicitamente a ausência do token', () => {
    const guards = sql.match(/IF p_expected_updated_at IS NULL THEN[\s\S]*?END IF;/g) ?? [];
    expect(guards.length).toBe(2);
    for (const g of guards) expect(g).toMatch(/CONFLITO: updated_at da serie ausente/);
  });

  it('o conflito é levantado antes de qualquer escrita', () => {
    // o guard precisa vir antes do primeiro DML real da função, senão haveria
    // alteração parcial antes de detectar o conflito. 'FOR UPDATE' é lock de
    // leitura e comentário não é DML, então os padrões são específicos.
    const dml = /\bUPDATE\s+transactions\b|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b/i;
    for (const fn of ['app.transaction_series_delete', 'app.transaction_series_edit']) {
      const from = sql.indexOf(`FUNCTION ${fn}(`);
      const to = sql.indexOf('$function$;', from);
      const body = sql.slice(from, to);
      const guard = body.indexOf('p_expected_updated_at IS NULL');
      const firstWrite = body.search(dml);
      expect(guard, `${fn}: guard ausente`).toBeGreaterThan(-1);
      expect(firstWrite, `${fn}: sem escrita`).toBeGreaterThan(-1);
      expect(guard, `${fn}: conflito só é detectado DEPOIS de mutar`).toBeLessThan(firstWrite);
    }
  });

  it('o frontend sempre envia o updated_at da série nos dois caminhos', () => {
    // nenhum builder pode inventar token a partir de outro domínio
    expect(editorSrc).toContain('series_updated_at');
    expect(delSrc).toContain('series_updated_at');
    expect(seriesScopeSrc).toMatch(/p_expected_updated_at: opts\.seriesUpdatedAt \?\? seriesInfo\.series_updated_at \?\? null/);
    expect(seriesScopeSrc).toMatch(/p_expected_updated_at: seriesUpdatedAt \?\? seriesInfo\.series_updated_at \?\? null/);
    expect(seriesScopeSrc).not.toMatch(/series_updated_at \?\? expectedUpdatedAt/);
    // e as consultas de detecção pedem o updated_at da série
    expect(editorSrc).toContain('transaction_series(total_occurrences, kind, updated_at)');
    expect(delSrc).toContain('transaction_series(kind, updated_at)');
  });
});

describe('E10E — regressões relatadas: editar para "paga" e excluir série de parcelas', () => {
  const info = { series_id: 's-1', occurrence_index: 2, total: 12, kind: 'installment', series_updated_at: 'series-ts' };

  it('alterar apenas o status preserva a categoria (sem set espúrio)', () => {
    const args = buildSeriesEditArgs(info, 'this', { ...payload, category_id: 'cat-1' }, 'tx-ts', false, {
      original: { category_id: 'cat-1', memo: null },
      seriesUpdatedAt: 'series-ts',
      statusEdited: true,
    });
    expect(args.p_category_action).toBe('preserve');
    expect(args.p_category_id).toBeNull();
    expect(args.p_status).toBe('posted');
    expect(args.p_confirm_posted).toBe(false);
  });

  it('substituir categoria = set com valor; remover = clear com id nulo (também em this)', () => {
    const set = buildSeriesEditArgs(info, 'this', { ...payload, category_id: 'cat-9' }, 'tx-ts', false, {
      original: { category_id: 'cat-1', memo: null },
      seriesUpdatedAt: 'series-ts',
    });
    expect(set.p_category_action).toBe('set');
    expect(set.p_category_id).toBe('cat-9');

    const clear = buildSeriesEditArgs(info, 'this', { ...payload, category_id: '' }, 'tx-ts', false, {
      original: { category_id: 'cat-1', memo: null },
      seriesUpdatedAt: 'series-ts',
    });
    expect(clear.p_category_action).toBe('clear');
    expect(clear.p_category_id).toBeNull();
    // preserve/clear jamais enviam valor: nada de 'set' forçado para silenciar a validação
    expect(clear.p_category_action === 'set' && clear.p_category_id).toBeFalsy();
  });

  it('status legado não tocado NÃO viaja (preservado sem normalização em this)', () => {
    const args = buildSeriesEditArgs(info, 'this', { ...payload, status: 'review' }, 'tx-ts', false, {
      original: { category_id: 'cat-1', memo: null },
      seriesUpdatedAt: 'series-ts',
      statusEdited: false,
    });
    expect(args.p_status).toBeNull();
  });

  it("'this' SEM aceite => flags false mesmo com prévia exigindo; COM aceite, envia como marcadas (edit)", () => {
    const imp = impact({ scope: 'this', pagas: 1, posted: 1, passadas: 1, editadas: 1, indices_editados: [2] });
    // requiredConfirms(imp) exige tudo, mas a prévia NUNCA concede confirmação:
    const semAceite = buildSeriesEditArgs(info, 'this', payload, 'tx-ts', false, {
      original: { category_id: 'cat-1', memo: null },
      seriesUpdatedAt: 'series-ts',
    });
    expect(requiredConfirms(imp)).toEqual({ past: true, posted: true, edited: true });
    expect(semAceite.p_confirm_posted).toBe(false);
    expect(semAceite.p_confirm_past).toBe(false);
    expect(semAceite.p_confirm_edited).toBe(false);

    const comAceite = buildSeriesEditArgs(info, 'this', payload, 'tx-ts', false, {
      original: { category_id: 'cat-1', memo: null },
      seriesUpdatedAt: 'series-ts',
      confirms: { past: true, posted: true, edited: true },
    });
    expect(comAceite.p_confirm_posted).toBe(true);
    expect(comAceite.p_confirm_past).toBe(true);
    expect(comAceite.p_confirm_edited).toBe(true);
  });

  it("'this' SEM aceite => false; COM aceite => flags correspondentes (delete)", () => {
    const imp = impact({ scope: 'this', pagas: 1, posted: 1, passadas: 0, editadas: 0 });
    expect(requiredConfirms(imp).posted).toBe(true);
    const semAceite = buildSeriesDeleteArgs(info, 'this', 'tx-ts', 'series-ts');
    expect(semAceite.p_confirm_posted).toBe(false);
    expect(semAceite.p_confirm_past).toBe(false);
    expect(semAceite.p_confirm_edited).toBe(false);

    const comAceite = buildSeriesDeleteArgs(info, 'this', 'tx-ts', 'series-ts', { posted: true });
    expect(comAceite.p_confirm_posted).toBe(true);
    expect(comAceite.p_confirm_past).toBe(false);
    expect(comAceite.p_confirm_edited).toBe(false);
  });

  it('confirmações vêm SÓ do aceite explícito em todos os escopos (a prévia nunca concede)', () => {
    // prévia exige, mas sem checkbox marcado => false, inclusive em 'this'
    const thisNo = buildSeriesEditArgs(info, 'this', payload, 'tx-ts', false, {
      original: { category_id: 'cat-1', memo: null },
      seriesUpdatedAt: 'series-ts',
    });
    expect(thisNo.p_confirm_posted).toBe(false);
    expect(thisNo.p_confirm_past).toBe(false);
    expect(thisNo.p_confirm_edited).toBe(false);

    const wholeNo = buildSeriesEditArgs(info, 'whole', payload, 'tx-ts', false, {
      original: { category_id: 'cat-1', memo: null },
      seriesUpdatedAt: 'series-ts',
    });
    expect(wholeNo.p_confirm_posted).toBe(false);
    expect(wholeNo.p_confirm_past).toBe(false);
    expect(wholeNo.p_confirm_edited).toBe(false);

    // coletivo com aceite explícito => envia como marcadas (comportamento preservado)
    const del = buildSeriesDeleteArgs(info, 'this_and_next', 'tx-ts', 'series-ts', {
      past: true,
      posted: true,
      edited: true,
    });
    expect(del.p_confirm_past).toBe(true);
    expect(del.p_confirm_posted).toBe(true);
    expect(del.p_confirm_edited).toBe(true);
  });

  it('delete com os escopos suportados: token da série + âncora em todos; whole sem âncora na prévia', () => {
    for (const scope of ['this', 'this_and_next', 'whole'] as SeriesScope[]) {
      const args = buildSeriesDeleteArgs(info, scope, 'tx-ts', 'series-ts');
      expect(args.p_series_id).toBe('s-1');
      expect(args.p_scope).toBe(scope);
      expect(args.p_expected_updated_at).toBe('series-ts');
    }
    expect(buildImpactArgs('s-1', 'this', 2).p_from_occurrence).toBe(2);
    expect(buildImpactArgs('s-1', 'whole', 2).p_from_occurrence).toBeNull();
  });

  it('os builders montam confirmações SÓ de aceite explícito; componentes passam confirms em edição e exclusão', () => {
    const fromEdit = editorSrc.indexOf('buildSeriesEditArgs(seriesInfo, scope, payload');
    const editCall = editorSrc.slice(fromEdit, fromEdit + 800);
    expect(editCall).toContain('confirms,');
    expect(editCall).toContain('statusEdited,');
    // E10F: a prévia (impact) NÃO viaja mais para o builder; só o aceite.
    expect(editCall).not.toContain('impact,');

    const editorDel = editorSrc.indexOf('buildSeriesDeleteArgs(seriesInfo, seriesScope ??');
    expect(editorDel).toBeGreaterThan(-1);
    const delCall = editorSrc.slice(editorDel, editorDel + 400);
    expect(delCall).toContain('confirms)');
    expect(delCall).not.toContain('impact');

    expect(delSrc).toMatch(
      /buildSeriesDeleteArgs\(\s*seriesInfo,\s*activeScope,\s*expectedUpdatedAt,\s*seriesInfo\.series_updated_at \?\? null,\s*confirms,?\s*\)/,
    );

    // nenhum escopo deriva flags da prévia: requiredConfirms fica só na UI,
    // e os builders leem exclusivamente o aceite explícito.
    expect(seriesScopeSrc).not.toMatch(/:\s*req\.(past|posted|edited)/);
    expect(seriesScopeSrc).toMatch(/p_confirm_posted:\s*!!c\.posted/);
    expect(seriesScopeSrc).toMatch(/p_confirm_posted:\s*!!confirms\.posted/);

    // a UI apresenta confirmação também em 'this' (texto de ocorrência única)
    expect(editorSrc).toContain('Confirmo que desejo alterar esta ocorrência com status posted (paga/postada).');
    expect(editorSrc).toContain('Confirmo que desejo excluir esta ocorrência com status posted (paga/postada).');
    expect(delSrc).toContain('Confirmo que desejo excluir esta ocorrência com status posted (paga/postada).');
  });
});

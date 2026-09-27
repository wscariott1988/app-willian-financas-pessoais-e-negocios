// PESSOAL-13C4A-E10B — escopos de ação em recorrências e parcelamentos.
//
// Cobre duas camadas sem tocar em banco:
//  1) contrato puro do cliente (lib/seriesScope.ts) — escopo, impacto,
//     confirmações e tri-estado de campos;
//  2) contrato estático da migration 027 — porque NÃO há PostgreSQL local
//     (proibido conectar) e a aplicação está bloqueada por backup (BL-4).
//     As asserções leem o SQL e exigem que os defeitos do catálogo implantado
//     NÃO reapareçam: status propagado, is_edited pulado, before_state depois
//     da mutação, valor de parcela em lote, e ausência de wrapper público.

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

  it('p_confirm_* só é true em escopo coletivo e com a confirmação marcada', () => {
    const c = { past: true, posted: true, edited: true };
    for (const scope of ['this_and_next', 'whole'] as SeriesScope[]) {
      const a = buildSeriesEditArgs(recurring, scope, payload, 'ts', false, { confirms: c });
      expect(a.p_confirm_past && a.p_confirm_posted && a.p_confirm_edited).toBe(true);
    }
    const one = buildSeriesEditArgs(recurring, 'this', payload, 'ts', true, { confirms: c });
    expect(one.p_confirm_past).toBe(false);
    expect(one.p_confirm_posted).toBe(false);
    expect(one.p_confirm_edited).toBe(false);
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
    // sem o updated_at da série, cai no updated_at da transação (legado)
    expect(buildSeriesDeleteArgs(recurring, 'this', 'tx-ts', null).p_expected_updated_at).toBe('tx-ts');
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

describe('E10B — exposição mínima: wrapper público só para authenticated', () => {
  it('existe wrapper public para os três RPCs usados pelo app', () => {
    for (const fn of ['series_scope_impact', 'transaction_series_edit', 'transaction_series_delete']) {
      expect(sql).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
    }
  });

  it('wrappers são INVOKER (não definer) e o app é exposto via public', () => {
    const wrappers = sql.match(/CREATE OR REPLACE FUNCTION public\.[\s\S]*?\$\$;/g) ?? [];
    expect(wrappers.length).toBe(3);
    for (const w of wrappers) {
      expect(w).toMatch(/SECURITY INVOKER/);
      expect(w).not.toMatch(/SECURITY DEFINER/);
      expect(w).toMatch(/SET search_path TO 'public', 'app'/);
    }
  });

  it('revoga PUBLIC/anon e concede apenas authenticated em app e public', () => {
    const revokes = sql.match(/REVOKE ALL ON FUNCTION (app|public)\.[\s\S]*?FROM PUBLIC, anon;/g) ?? [];
    expect(revokes.length).toBe(6);
    const grants = sql.match(/GRANT EXECUTE ON FUNCTION (app|public)\.[\s\S]*?TO authenticated;/g) ?? [];
    expect(grants.length).toBe(6);
    expect(sql).not.toMatch(/TO anon;/);
    expect(sql).not.toMatch(/TO service_role;/);
  });

  it('as funções app que fazem o trabalho real são SECURITY DEFINER', () => {
    // a de impacto é STABLE (read-only); as mutantes são VOLATILE por padrão
    expect(sql).toMatch(/FUNCTION app\.series_scope_impact[\s\S]*?LANGUAGE plpgsql\nSTABLE\nSECURITY DEFINER/);
    const mut = sql.match(/FUNCTION app\.transaction_series_(edit|delete)[\s\S]*?LANGUAGE plpgsql\nSECURITY DEFINER/g) ?? [];
    expect(mut.length).toBe(2);
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

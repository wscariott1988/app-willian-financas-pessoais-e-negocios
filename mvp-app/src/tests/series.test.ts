import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  seriesOccurrenceDate,
  installmentAmount,
  seriesOccurrenceStatus,
  seriesTotalOccurrences,
  buildSeriesPreview,
  previewLine,
  previewSummary,
  extractSeriesMeta,
  seriesDisplayLabel,
  SERIES_KIND_LABELS,
  SERIES_FREQUENCY_LABELS,
  SERIES_SCOPE_LABELS,
  RECURRING_HORIZON,
  MAX_INSTALLMENTS,
} from '../lib/series';
import { ENTRY_TYPE_LABELS, buildSeriesEditArgs } from '../components/TransactionEditor';

const here = dirname(fileURLToPath(import.meta.url));
function readEditor(): string {
  return readFileSync(resolve(here, '..', 'components', 'TransactionEditor.tsx'), 'utf8');
}

describe('Package 015 — datas mensais (contrato B: último dia do mês)', () => {
  it('dia 10: 10/01 -> 10/02 -> 10/03', () => {
    expect(seriesOccurrenceDate('2026-01-10', 'monthly', 1)).toBe('2026-01-10');
    expect(seriesOccurrenceDate('2026-01-10', 'monthly', 2)).toBe('2026-02-10');
    expect(seriesOccurrenceDate('2026-01-10', 'monthly', 3)).toBe('2026-03-10');
  });

  it('dia 31: 31/01 -> 28/02 -> 31/03 (último dia do mês)', () => {
    expect(seriesOccurrenceDate('2026-01-31', 'monthly', 1)).toBe('2026-01-31');
    expect(seriesOccurrenceDate('2026-01-31', 'monthly', 2)).toBe('2026-02-28');
    expect(seriesOccurrenceDate('2026-01-31', 'monthly', 3)).toBe('2026-03-31');
  });

  it('dia 31 em mês de 30: 31/03 -> 30/04', () => {
    expect(seriesOccurrenceDate('2026-03-31', 'monthly', 2)).toBe('2026-04-30');
  });

  it('fevereiro bissexto: 29/01/2024 -> 29/02/2024 (bissexto) e 28/02/2023 (não)', () => {
    expect(seriesOccurrenceDate('2024-01-29', 'monthly', 2)).toBe('2024-02-29');
    expect(seriesOccurrenceDate('2023-01-29', 'monthly', 2)).toBe('2023-02-28');
  });

  it('dia 30 em fevereiro: 30/01 -> 28/02 -> 30/03', () => {
    expect(seriesOccurrenceDate('2026-01-30', 'monthly', 2)).toBe('2026-02-28');
    expect(seriesOccurrenceDate('2026-01-30', 'monthly', 3)).toBe('2026-03-30');
  });
});

describe('Package 015 — frequências', () => {
  it('semanal: +7 dias por ocorrência', () => {
    expect(seriesOccurrenceDate('2026-01-01', 'weekly', 1)).toBe('2026-01-01');
    expect(seriesOccurrenceDate('2026-01-01', 'weekly', 2)).toBe('2026-01-08');
    expect(seriesOccurrenceDate('2026-01-01', 'weekly', 5)).toBe('2026-01-29');
  });

  it('anual: mesmo dia no ano seguinte (último dia quando necessário)', () => {
    expect(seriesOccurrenceDate('2026-05-20', 'yearly', 2)).toBe('2027-05-20');
    expect(seriesOccurrenceDate('2024-02-29', 'yearly', 2)).toBe('2025-02-28');
  });

  it('labels amigáveis (sem termos técnicos)', () => {
    expect(SERIES_KIND_LABELS.installment).toBe('Parcelada');
    expect(SERIES_KIND_LABELS.recurring).toBe('Recorrente');
    expect(SERIES_FREQUENCY_LABELS.monthly).toBe('Mensal');
    expect(SERIES_FREQUENCY_LABELS.weekly).toBe('Semanal');
    expect(SERIES_FREQUENCY_LABELS.yearly).toBe('Anual');
    expect(ENTRY_TYPE_LABELS.single).toBe('Única');
  });
});

describe('Package 015 — valores (contrato A: total; arredondamento determinístico)', () => {
  it('1200 / 12 = 12 x 100,00', () => {
    const vals = Array.from({ length: 12 }, (_, i) => installmentAmount(1200, i + 1, 12));
    expect(vals.every((v) => v === 100)).toBe(true);
    expect(vals.reduce((a, b) => a + b, 0)).toBe(1200);
  });

  it('1201 / 12: 11 x 100,08 + última 100,12 (soma exata)', () => {
    const vals = Array.from({ length: 12 }, (_, i) => installmentAmount(1201, i + 1, 12));
    expect(vals.slice(0, 11).every((v) => v === 100.08)).toBe(true);
    expect(vals[11]).toBe(100.12);
    expect(vals.reduce((a, b) => a + b, 0)).toBe(1201);
  });

  it('100 / 3 = 33,33 + 33,33 + 33,34', () => {
    const vals = Array.from({ length: 3 }, (_, i) => installmentAmount(100, i + 1, 3));
    expect(vals).toEqual([33.33, 33.33, 33.34]);
    expect(vals.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('1 parcela = total inteiro', () => {
    expect(installmentAmount(1234.56, 1, 1)).toBe(1234.56);
  });
});

describe('Package 015 — status (contrato F: futuras = scheduled)', () => {
  it('ocorrência no passado/hoje usa o status escolhido', () => {
    expect(seriesOccurrenceStatus('2000-01-01', 'posted')).toBe('posted');
    expect(seriesOccurrenceStatus('2000-01-01', 'pending')).toBe('pending');
  });

  it('ocorrência futura nasce scheduled', () => {
    expect(seriesOccurrenceStatus('2099-01-01', 'posted')).toBe('scheduled');
    expect(seriesOccurrenceStatus('2099-01-01', 'pending')).toBe('scheduled');
  });
});

describe('Package 015 — total de ocorrências / horizonte (contrato G/D)', () => {
  it('parcelamento: usa quantidade informada (limite 120)', () => {
    expect(seriesTotalOccurrences('installment', 12)).toBe(12);
    expect(seriesTotalOccurrences('installment', null)).toBe(0);
    expect(seriesTotalOccurrences('installment', 999)).toBe(MAX_INSTALLMENTS);
  });

  it('recorrência aberta: horizonte 24 (nunca infinito)', () => {
    expect(seriesTotalOccurrences('recurring', null)).toBe(RECURRING_HORIZON);
    expect(RECURRING_HORIZON).toBe(24);
  });

  it('recorrência finita: respeita total informado', () => {
    expect(seriesTotalOccurrences('recurring', 12)).toBe(12);
  });
});

describe('Package 015 — preview (nenhum write)', () => {
  it('gera linhas com data/valor/status e valida conta/categoria', () => {
    const { rows, total } = buildSeriesPreview(
      'expense', 'installment', 'monthly', 1200, 12, '2026-01-10',
      () => true, true,
    );
    expect(total).toBe(12);
    expect(rows.length).toBe(12);
    expect(rows[0].occurred_on).toBe('2026-01-10');
    expect(rows[0].amount).toBe(100);
    expect(rows[0].index).toBe(1);
    expect(rows[11].index).toBe(12);
    expect(rows.every((r) => r.account_valid && r.category_valid)).toBe(true);
  });

  it('detecta conta inválida em datas futuras (ex.: conta fechada)', () => {
    const { rows } = buildSeriesPreview(
      'expense', 'installment', 'monthly', 300, 3, '2026-01-31',
      (date) => date <= '2026-02-28', true,
    );
    expect(rows[0].account_valid).toBe(true); // 31/01
    expect(rows[1].account_valid).toBe(true); // 28/02
    expect(rows[2].account_valid).toBe(false); // 31/03 fora
  });

  it('detecta categoria inválida', () => {
    const { rows } = buildSeriesPreview(
      'expense', 'installment', 'monthly', 300, 3, '2026-01-10',
      () => true, false,
    );
    expect(rows.every((r) => r.category_valid === false)).toBe(true);
  });

  it('linhas amigáveis sem UUID/JSON/técnica', () => {
    const { rows } = buildSeriesPreview(
      'expense', 'installment', 'monthly', 1200, 12, '2026-01-10',
      () => true, true,
    );
    const line = previewLine(rows[0]);
    expect(line).toContain('1');
    expect(line).toContain('10/01/2026');
    expect(line).toContain('R$ 100,00');
    expect(line).not.toContain('uuid');
    expect(line).not.toContain('{');
    expect(line).not.toContain('series_id');
    expect(previewSummary(rows)).toContain('12');
  });
});

describe('Package 015 — UI (TransactionEditor)', () => {
  const src = readEditor();

  it('opções Única/Parcelada/Recorrente presentes (criação)', () => {
    expect(src).toContain('Única');
    expect(src).toContain('Parcelada');
    expect(src).toContain('Recorrente');
  });

  it('transferência nunca entra em série (bloqueada com condição)', () => {
    expect(src).toContain("form.kind !== 'transfer'");
  });

  it('preview mostra contagem e primeira linhas; sem write ao abrir', () => {
    expect(src).toContain('previewSummary');
    expect(src).toContain('previewLine');
    expect(src).toContain('… e mais');
  });

  it('escopos de edição/exclusão (this | this_and_next | whole)', () => {
    expect(SERIES_SCOPE_LABELS.this).toBe('Somente esta ocorrência');
    expect(SERIES_SCOPE_LABELS.this_and_next).toBe('Esta e as próximas');
    expect(SERIES_SCOPE_LABELS.whole).toBe('Série inteira');
    expect(src).toContain('transaction_series_edit');
    expect(src).toContain('transaction_series_delete');
    expect(src).toContain('transaction_series_create');
  });

  it('aviso explícito de que "série inteira" altera passado', () => {
    expect(src).toMatch(/alterar também ocorrências passadas/i);
  });

  it('confirmação forte de passado no backend (checkbox + confirm_past no RPC)', () => {
    expect(src).toContain('Confirmo que desejo alterar também ocorrências passadas');
    expect(src).toContain('p_confirm_past');
    expect(src).toContain('Confirmo que desejo excluir também ocorrências passadas');
  });

  it('ação amigável "Gerar próximas ocorrências" (nunca automática) para recorrência aberta', () => {
    expect(src).toContain('Gerar próximas ocorrências');
    expect(src).toContain('transaction_series_materialize');
    // a chamada vive somente em doExtendSeries (botão); nenhum useEffect a dispara
    const effects = src.match(/useEffect\(\(\) => \{[^]*?\}\);/g) ?? [];
    for (const eff of effects) {
      expect(eff).not.toContain('transaction_series_materialize');
    }
    expect(src).toContain('Todas as ocorrências já foram geradas até agora');
  });

  it('nenhum campo técnico exibido (series_id/idempotency/UUID)', () => {
    const jsx = src.slice(src.lastIndexOf('return ('));
    expect(jsx).not.toContain('series_id');
    expect(jsx).not.toContain('idempotency');
    expect(jsx).not.toContain('p_idempotency_key');
  });

  it('ocorrências editadas individualmente são preservadas (is_edited)', () => {
    expect(src).toMatch(/Ocorrências editadas individualmente são preservadas/i);
  });

  it('BUG 1: recorrente envia p_amount com o novo valor; parcelas enviam null (nunca numérico)', () => {
    expect(src).toContain("p_amount: seriesInfo.kind === 'recurring' ? payload.amount : null,");
  });

  it('BUG 1: installment não envia alteração indevida de amount pelo caminho de série', () => {
    const from = src.indexOf("supabase.rpc('transaction_series_edit'");
    const to = src.indexOf("supabase.rpc('transaction_update'");
    const editCall = src.slice(from, to);
    // os argumentos da edição em lote vêm do helper buildSeriesEditArgs (p_amount null em parcelas)
    expect(editCall).toMatch(/buildSeriesEditArgs\(seriesInfo, scope, payload, expectedUpdatedAt, confirmPast\)/);
    expect(editCall).not.toContain('p_amount: payload.amount,');
  });

  it('BUG 1: transação comum (sem série) continua usando transaction_update', () => {
    expect(src).toContain("const res = await supabase.rpc('transaction_update', {");
    // a chamada de série é exclusiva do ramo `if (seriesInfo)` da edição
    expect(src).toMatch(/transaction_series_edit[\s\S]*?\} else \{\s+const res = await supabase\.rpc\('transaction_update'/);
  });
});

describe('Package 015 — BUG 1 regressão (buildSeriesEditArgs)', () => {
  const payload = {
    description: 'Nova descrição da parcela',
    amount: '49.84',
    account_id: 'acc-1',
    category_id: 'cat-1',
    status: 'posted',
    memo: null,
  };
  const recurring = { series_id: 's-1', occurrence_index: 3, total: 12, kind: 'recurring' };
  const installment = { series_id: 's-1', occurrence_index: 3, total: 12, kind: 'installment' };

  it('recorrente: p_amount = novo valor e escopo default this', () => {
    const args = buildSeriesEditArgs(recurring, 'this', payload, 'ts-1', false);
    expect(args.p_amount).toBe('49.84');
    expect(args.p_scope).toBe('this');
  });

  it('installment: p_amount é null (backend rejeitaria valor em lote)', () => {
    const args = buildSeriesEditArgs(installment, 'this', payload, 'ts-1', false);
    expect(args.p_amount).toBeNull();
  });

  it('installment: p_amount é null nos TRÊS escopos (guarda do backend é incondicional)', () => {
    for (const scope of ['this', 'this_and_next', 'whole'] as const) {
      const args = buildSeriesEditArgs(installment, scope, payload, 'ts-1', false);
      expect(args.p_amount).toBeNull();
    }
  });

  it('recorrente: p_amount carrega o valor novo nos TRÊS escopos', () => {
    for (const scope of ['this', 'this_and_next', 'whole'] as const) {
      const args = buildSeriesEditArgs(recurring, scope, payload, 'ts-1', false);
      expect(args.p_amount).toBe('49.84');
    }
  });

  it('installment: descrição, ocorrência de partida e série ainda são propagadas', () => {
    const args = buildSeriesEditArgs(installment, 'this', payload, 'ts-1', false);
    expect(args.p_display_name).toBe('Nova descrição da parcela');
    expect(args.p_from_occurrence).toBe(3);
    expect(args.p_series_id).toBe('s-1');
    expect(args.p_expected_updated_at).toBe('ts-1');
  });

  it('scope whole propaga p_confirm_past; this/this_and_next enviam false', () => {
    expect(buildSeriesEditArgs(installment, 'whole', payload, 'ts-1', true).p_confirm_past).toBe(true);
    expect(buildSeriesEditArgs(installment, 'this_and_next', payload, 'ts-1', true).p_confirm_past).toBe(false);
    expect(buildSeriesEditArgs(installment, 'this', payload, 'ts-1', true).p_confirm_past).toBe(false);
  });
});

describe('Package 015 — badges de série (extractSeriesMeta/seriesDisplayLabel)', () => {
  it('parcela: "Parcela N de T" quando o total é informado', () => {
    const meta = extractSeriesMeta({
      occurrence_index: 3,
      transaction_series: { kind: 'installment', total_occurrences: 12 },
    });
    expect(meta).toEqual({ kind: 'installment', occurrence_index: 3, total_occurrences: 12 });
    expect(seriesDisplayLabel(meta)).toBe('Parcela 3 de 12');
  });

  it('PESSOAL-10 regressão: occurrence_index=2 + total=10 => "Parcela 2 de 10" (nunca 3 de 10)', () => {
    const meta = extractSeriesMeta({
      occurrence_index: 2,
      transaction_series: { kind: 'installment', total_occurrences: 10 },
    });
    const label = seriesDisplayLabel(meta);
    expect(label).toBe('Parcela 2 de 10');
    expect(label).not.toBe('Parcela 3 de 10');
    expect(label).not.toContain('+ 1');
  });

  it('parcela sem total: apenas "Parcela N" (nunca "/99")', () => {
    const meta = extractSeriesMeta({
      occurrence_index: 3,
      transaction_series: { kind: 'installment', total_occurrences: null },
    });
    expect(seriesDisplayLabel(meta)).toBe('Parcela 3');
  });

  it('recorrente: "Recorrente" (nunca "Parcela" nem "/24")', () => {
    const meta = extractSeriesMeta({
      occurrence_index: 7,
      transaction_series: { kind: 'recurring', total_occurrences: 24 },
    });
    expect(seriesDisplayLabel(meta)).toBe('Recorrente');
  });

  it('transação sem série (embed ausente/null) -> sem badge', () => {
    expect(extractSeriesMeta(null)).toBeNull();
    expect(extractSeriesMeta(undefined)).toBeNull();
    expect(seriesDisplayLabel(null)).toBeNull();
  });

  it('ordenação defensiva: embed no formato array (variante PostgREST)', () => {
    const meta = extractSeriesMeta({
      occurrence_index: 1,
      transaction_series: [{ kind: 'installment', total_occurrences: 3 }],
    });
    expect(seriesDisplayLabel(meta)).toBe('Parcela 1 de 3');
  });

  it('kind desconhecido ou ocorrência sem índice -> sem badge', () => {
    expect(extractSeriesMeta({ occurrence_index: 1, transaction_series: { kind: 'open' } })).toBeNull();
    expect(extractSeriesMeta({ transaction_series: { kind: 'installment', total_occurrences: 3 } })).toBeNull();
  });
});

describe('PESSOAL-10 — valor bloqueado em parcelas existentes (edição)', () => {
  const src = readEditor();

  it('installment existente => CurrencyInput desabilitado', () => {
    expect(src).toContain('installmentValueLocked');
    expect(src).toContain("seriesInfo.kind === 'installment'");
    expect(src).toContain('disabled={installmentValueLocked}');
  });

  it('recurring e transação comum => valor permanece editável (lock só para installment)', () => {
    const flag = src.match(/const installmentValueLocked = ([^;]+);/);
    expect(flag).not.toBeNull();
    expect(flag![1]).toContain('isEdit');
    expect(flag![1]).toContain("seriesInfo.kind === 'installment'");
  });

  it('novo lançamento / criação de parcelamento não bloqueia o valor', () => {
    const flag = src.match(/const installmentValueLocked = ([^;]+);/);
    expect(flag![1]).not.toContain('entryType');
    expect(flag![1].includes('isEdit')).toBe(true);
  });

  it('descrição de installment salva com p_amount = null (valor nunca enviado)', () => {
    const payload = {
      description: 'Renomear mercado',
      amount: '49.84',
      account_id: 'acc-1',
      category_id: 'cat-1',
      status: 'posted',
      memo: 'nova obs',
    };
    const args = buildSeriesEditArgs(
      { series_id: 's-1', occurrence_index: 3, total: 12, kind: 'installment' },
      'this',
      payload,
      'ts-1',
      false,
    );
    expect(args.p_amount).toBeNull();
    expect(args.p_display_name).toBe('Renomear mercado');
    expect(args.p_memo).toBe('nova obs');
  });

  it('recorrente continua enviando o valor alterado', () => {
    const args = buildSeriesEditArgs(
      { series_id: 's-1', occurrence_index: 3, total: 12, kind: 'recurring' },
      'this',
      { description: 'X', amount: '99.90', account_id: 'a', category_id: null, status: 'posted', memo: null },
      'ts-1',
      false,
    );
    expect(args.p_amount).toBe('99.90');
  });

  it('mensagem "O valor das parcelas não pode ser alterado." aparece apenas no caso correto', () => {
    const occurrences = src.match(/O valor das parcelas não pode ser alterado\./g) ?? [];
    expect(occurrences.length).toBe(1);
    expect(src).toMatch(/\{installmentValueLocked && \(\s*<span[^>]*>\s*O valor das parcelas não pode ser alterado\./);
    // a mensagem exibida não carrega jargão técnico
    expect('O valor das parcelas não pode ser alterado.').not.toMatch(/RPC|backend|RPC|edit/);
  });
});
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
  SERIES_KIND_LABELS,
  SERIES_FREQUENCY_LABELS,
  SERIES_SCOPE_LABELS,
  RECURRING_HORIZON,
  MAX_INSTALLMENTS,
} from '../lib/series';
import { ENTRY_TYPE_LABELS } from '../components/TransactionEditor';

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
});
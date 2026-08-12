import { describe, it, expect } from 'vitest';
import {
  computePeriodRange,
  addMonths,
  daysInMonth,
  selectionFromDate,
  isSameMonth,
  toLocalISODate,
  formatMonthLabel,
  formatShortDate,
} from '../lib/period';

// Datas locais fixas (construídas com componentes locais — nunca com UTC).
const todayAug12 = () => new Date(2026, 7, 12); // 12/08/2026
const todayMar31 = () => new Date(2026, 2, 31); // 31/03/2026

describe('daysInMonth', () => {
  it('mês de 28 dias (fevereiro 2026, ano não bissexto)', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it('mês de 29 dias (fevereiro 2028, ano bissexto)', () => {
    expect(daysInMonth(2028, 2)).toBe(29);
  });

  it('mês de 30 dias (abril)', () => {
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it('mês de 31 dias (agosto)', () => {
    expect(daysInMonth(2026, 8)).toBe(31);
  });
});

describe('addMonths', () => {
  it('volta um mês', () => {
    expect(addMonths({ year: 2026, month: 8 }, -1)).toEqual({ year: 2026, month: 7 });
  });

  it('avança um mês', () => {
    expect(addMonths({ year: 2026, month: 8 }, 1)).toEqual({ year: 2026, month: 9 });
  });

  it('muda de ano ao voltar de janeiro', () => {
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });

  it('muda de ano ao avançar de dezembro', () => {
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
  });
});

describe('selectionFromDate / isSameMonth', () => {
  it('extrai mês e ano locais da data', () => {
    expect(selectionFromDate(todayAug12())).toEqual({ year: 2026, month: 8 });
  });

  it('compara o mesmo mês', () => {
    expect(isSameMonth({ year: 2026, month: 8 }, selectionFromDate(todayAug12()))).toBe(true);
    expect(isSameMonth({ year: 2025, month: 8 }, selectionFromDate(todayAug12()))).toBe(false);
  });
});

describe('computePeriodRange — mês atual (12/08/2026)', () => {
  it('Até hoje: dia 1 até a data atual', () => {
    expect(computePeriodRange({ year: 2026, month: 8 }, 'up_to_today', todayAug12()))
      .toEqual({ start: '2026-08-01', end: '2026-08-12' });
  });

  it('Hoje ao fim do mês: data atual até o último dia', () => {
    expect(computePeriodRange({ year: 2026, month: 8 }, 'today_to_end', todayAug12()))
      .toEqual({ start: '2026-08-12', end: '2026-08-31' });
  });

  it('Mês todo: primeiro ao último dia', () => {
    expect(computePeriodRange({ year: 2026, month: 8 }, 'full_month', todayAug12()))
      .toEqual({ start: '2026-08-01', end: '2026-08-31' });
  });
});

describe('computePeriodRange — mês anterior (julho/2026)', () => {
  it('Até hoje: corte no mesmo número do dia atual (12)', () => {
    expect(computePeriodRange({ year: 2026, month: 7 }, 'up_to_today', todayAug12()))
      .toEqual({ start: '2026-07-01', end: '2026-07-12' });
  });

  it('Hoje ao fim do mês: do dia 12 ao último dia', () => {
    expect(computePeriodRange({ year: 2026, month: 7 }, 'today_to_end', todayAug12()))
      .toEqual({ start: '2026-07-12', end: '2026-07-31' });
  });

  it('Mês todo: 01 a 31', () => {
    expect(computePeriodRange({ year: 2026, month: 7 }, 'full_month', todayAug12()))
      .toEqual({ start: '2026-07-01', end: '2026-07-31' });
  });
});

describe('computePeriodRange — mês posterior (setembro/2026)', () => {
  it('Até hoje: corte no mesmo número do dia atual (12)', () => {
    expect(computePeriodRange({ year: 2026, month: 9 }, 'up_to_today', todayAug12()))
      .toEqual({ start: '2026-09-01', end: '2026-09-12' });
  });

  it('Hoje ao fim do mês: do dia 12 ao último dia', () => {
    expect(computePeriodRange({ year: 2026, month: 9 }, 'today_to_end', todayAug12()))
      .toEqual({ start: '2026-09-12', end: '2026-09-30' });
  });

  it('Mês todo: 01 a 30', () => {
    expect(computePeriodRange({ year: 2026, month: 9 }, 'full_month', todayAug12()))
      .toEqual({ start: '2026-09-01', end: '2026-09-30' });
  });
});

describe('computePeriodRange — mudança de ano', () => {
  it('dezembro do ano anterior quando hoje é janeiro', () => {
    const todayJan5 = () => new Date(2027, 0, 5);
    expect(computePeriodRange({ year: 2026, month: 12 }, 'up_to_today', todayJan5()))
      .toEqual({ start: '2026-12-01', end: '2026-12-05' });
    expect(computePeriodRange({ year: 2026, month: 12 }, 'today_to_end', todayJan5()))
      .toEqual({ start: '2026-12-05', end: '2026-12-31' });
  });

  it('janeiro do ano seguinte quando hoje é dezembro', () => {
    const todayDec30 = () => new Date(2026, 11, 30);
    expect(computePeriodRange({ year: 2027, month: 1 }, 'full_month', todayDec30()))
      .toEqual({ start: '2027-01-01', end: '2027-01-31' });
  });
});

describe('computePeriodRange — corte limitado ao último dia do mês', () => {
  it('dia 31 é limitado para fevereiro de 28 dias (2026)', () => {
    expect(computePeriodRange({ year: 2026, month: 2 }, 'up_to_today', todayMar31()))
      .toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(computePeriodRange({ year: 2026, month: 2 }, 'today_to_end', todayMar31()))
      .toEqual({ start: '2026-02-28', end: '2026-02-28' });
  });

  it('dia 31 é limitado para fevereiro de 29 dias (2028, bissexto)', () => {
    expect(computePeriodRange({ year: 2028, month: 2 }, 'up_to_today', todayMar31()))
      .toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });
});

describe('sem deslocamento por fuso horário (UTC)', () => {
  it('hora local tardia (23:59) não desloca o dia do corte', () => {
    // 12/08/2026 às 23:59:59 no fuso local. Se o cálculo usasse toISOString()/UTC,
    // em fusos negativos o corte viraria 13/08 — a asserção exata prova que não há deslocamento.
    const lateToday = new Date(2026, 7, 12, 23, 59, 59);
    expect(computePeriodRange({ year: 2026, month: 8 }, 'up_to_today', lateToday))
      .toEqual({ start: '2026-08-01', end: '2026-08-12' });
  });

  it('hora local inicial (00:01) mantém o dia correto', () => {
    const earlyToday = new Date(2026, 7, 12, 0, 1, 0);
    expect(computePeriodRange({ year: 2026, month: 8 }, 'today_to_end', earlyToday))
      .toEqual({ start: '2026-08-12', end: '2026-08-31' });
  });

  it('toLocalISODate produz strings determinísticas (sem UTC)', () => {
    expect(toLocalISODate(2026, 8, 12)).toBe('2026-08-12');
    expect(toLocalISODate(2026, 1, 1)).toBe('2026-01-01');
  });
});

describe('formatMonthLabel / formatShortDate', () => {
  it('formata o rótulo do mês em pt-BR', () => {
    expect(formatMonthLabel({ year: 2026, month: 8 })).toBe('agosto de 2026');
  });

  it('formata data curta dd/mm/aaaa', () => {
    expect(formatShortDate('2026-08-12')).toBe('12/08/2026');
  });
});

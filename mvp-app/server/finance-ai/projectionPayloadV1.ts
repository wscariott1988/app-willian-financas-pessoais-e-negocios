// projectionPayloadV1.ts — Contrato versionado + mapeador + sanitizador do
// payload de projeção (PESSOAL-13C4A, Fase 4A).
//
// Objetivo: definir a forma FINAL e persistível dos dados de projeção que um
// dia alimentará o cache/listMessages. Esta fase NÃO conecta nada (resposta
// fresca, cache, listMessages, UI ou follow-ups ficam para depois) — a
// fronteira fechada existe para o resto do fluxo consumir por aqui.
//
// Contrato (ProjectionPayloadV1, união discriminada por `status`):
//   - success → quality 'full' | 'preliminary'
//   - insufficient → quality 'insufficient'
//   - um dos QUATRO intents reais de projeção (projection_base,
//     projection_current_month, projection_month_comparison,
//     projection_categories) — NUNCA clarification;
//   - mês de referência YYYY-MM + kind current | past;
//   - cobertura e limites usados;
//   - agregados mensais/anuais/totais em centavos;
//   - comparação geral = UNIÃO DISCRIMINADA por referenceBasis:
//       'monthly_mean'     → MÊS PASSADO e MÊS ATUAL NOVO (PESSOAL-13C4A-E3.7):
//                            a referência é a média mensal completa da base nos
//                            DOIS casos (mesma forma; só reference.kind difere).
//                            SEM campos exclusivos do mês atual;
//       'expected_to_date' → SOMENTE LEITURA de payload LEGADO (pré-E3.7) do
//                            mês atual: expectedToDateCents obrigatório
//                            (referência proporcional até o dia),
//                            futureRegisteredCents e committedCents, e
//                            closingProjectionCents number|null. O mapeador
//                            NUNCA gera essa forma — apenas o sanitizador a
//                            aceita para ler mensagens persistidas antigas;
//   - comparação above | below | equal quando aplicável;
//   - categorias (≤ 8): rótulo, média dos meses cobertos e os comparativos que
//     o motor JÁ fornece por categoria — realizado no mês atual/selecionado,
//     referência, diferença e desvio (mapeados direto, NUNCA recalculados);
//     cada categoria carrega AINDA o modo de card fechado (variable_pace |
//     monthly_commitment | investment_allocation) e a base de comparação usada:
//     no mês atual E no passado, SEMPRE 'monthly_mean' (média completa);
//     categorias legadas do mês atual (leitura) podem carregar
//     futureRegisteredCents/committedCents com a coerência modo ↔ base antiga;
//   - agregado `remaining` quando existir (count > 0): apenas count/média/anual
//     — o motor NÃO fornece comparativos do remaining, então não são inventados.
//   - insufficient: somente contexto seguro, cobertura, motivo permitido e
//     realizado disponível — nunca média projetada, fechamento, anualização,
//     comparação ou categorias inventadas.
//
// Sanitizador:
//   - entrada tratada como unknown; allowlists fechadas (version, intent,
//     quality, reference kind, reason code, deviation, MODO de categoria);
//   - valida coerência cruzada da comparação (PESSOAL-13C4A-E3.7):
//     referenceBasis 'monthly_mean' vale para 'current' (novo) e 'past';
//     'expected_to_date' vale SOMENTE para 'current' LEGADO e exige os QUATRO
//     campos exclusivos; campos exclusivos do mês atual injetados numa
//     comparação monthly_mean (atual novo ou passado) → undefined;
//   - valida coerência cruzada POR CATEGORIA: passado → 'monthly_mean' sempre e
//     nunca future/committed; mês atual NOVO (comparaçção monthly_mean) →
//     'monthly_mean' e nunca future/committed; mês atual LEGADO (comparação
//     expected_to_date) → mantém a regra pré-E3.7: variable_pace exige
//     'expected_to_date', monthly_commitment/investment_allocation exigem
//     'monthly_mean' e future/committed são obrigatórios — qualquer combinação
//     fora disso → undefined;
//   - apenas inteiros seguros e finitos (preserva 0 legitimamente);
//   - closingProjectionCents: null preservado exatamente; inteiro seguro
//     (inclusive 0) também preservado;
//   - valida YYYY-MM;
//   - limpa HTML/caracteres de controle e limita rótulos;
//   - trunca categorias em oito;
//   - remove IDs, perguntas, descrições, transações, contas, objetos Supabase e
//     propriedades desconhecidas (recursivamente, campo a campo);
//   - estruturalmente inválido → undefined (nunca objeto parcial enganoso);
//   - idempotente: sanitize(sanitize(x)) === sanitize(x).
//
// Mapeador ÚNICO de ProjectionEngineResult para o contrato: NÃO replica
// cálculos do motor (usa os agregados prontos e as constantes do motor) e NÃO
// inclui timestamp de geração — determinismo total.

import {
  MINIMUM_COVERAGE_MONTHS,
  REQUIRED_FULL_COVERAGE_MONTHS,
  TOP_CATEGORIES_LIMIT,
  type ProjectionBasis,
  type ProjectionEngineResult,
} from '../../src/lib/analyticsProjection.js';

// ============ Constantes e allowlists fechadas ============

export const PROJECTION_PAYLOAD_VERSION = 1;
export const PROJECTION_CATEGORIES_MAX = TOP_CATEGORIES_LIMIT;
export const PROJECTION_LABEL_MAX = 120;
/** Teto do nome exibível da lente (apenas texto de exibição; nunca ids/paths internos). */
export const PROJECTION_LENS_LABEL_MAX = 60;

export const PROJECTION_INTENTS: ReadonlyArray<ProjectionPayloadIntent> = [
  'projection_base',
  'projection_current_month',
  'projection_month_comparison',
  'projection_categories',
];
export const PROJECTION_QUALITIES: ReadonlyArray<ProjectionPayloadQuality> = [
  'full',
  'preliminary',
];
export const PROJECTION_REFERENCE_KINDS: ReadonlyArray<ProjectionPayloadReferenceKind> = [
  'current',
  'past',
];
export const PROJECTION_DEVIATIONS: ReadonlyArray<ProjectionPayloadDeviation> = [
  'above',
  'below',
  'equal',
];
export const PROJECTION_COMPARISON_BASIS: ReadonlyArray<ProjectionPayloadComparisonBasis> = [
  'expected_to_date',
  'monthly_mean',
];
export const PROJECTION_CATEGORY_MODES: ReadonlyArray<ProjectionPayloadCategoryMode> = [
  'variable_pace',
  'monthly_commitment',
  'investment_allocation',
];
export const PROJECTION_REASON_CODES: ReadonlyArray<ProjectionPayloadReasonCode> = [
  'covered_months_below_minimum',
];

/** Formato fechado de mês (YYYY-MM), tolerante a anos com 4 dígitos apenas. */
export const PROJECTION_YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ============ Tipos do contrato ============

export type ProjectionPayloadIntent =
  | 'projection_base' // próximos 12 meses / anualizada
  | 'projection_current_month' // fechamento estimado do mês atual
  | 'projection_month_comparison' // mês atual/passado vs média dos 12 anteriores
  | 'projection_categories'; // projeção geral por categorias
export type ProjectionPayloadQuality = 'full' | 'preliminary';
export type ProjectionPayloadReferenceKind = 'current' | 'past';
export type ProjectionPayloadDeviation = 'above' | 'below' | 'equal';
export type ProjectionPayloadComparisonBasis = 'expected_to_date' | 'monthly_mean';
export type ProjectionPayloadReasonCode = 'covered_months_below_minimum';

/**
 * Modo de card de uma categoria (PESSOAL-13C4A-E3.3), lista fechada espelhando
 * o motor. variable_pace = ritmo proporcional até hoje (mês atual);
 * monthly_commitment = compromissos fixos/dívidas com média mensal completa;
 * investment_allocation = aportes/investimentos com média mensal de aportes.
 */
export type ProjectionPayloadCategoryMode =
  | 'variable_pace'
  | 'monthly_commitment'
  | 'investment_allocation';

export interface ProjectionPayloadReferenceV1 {
  month: string;
  kind: ProjectionPayloadReferenceKind;
}

export interface ProjectionPayloadCoverageV1 {
  windowMonths: number;
  coveredMonths: number;
  minimumCoverageMonths: number;
  requiredFullCoverageMonths: number;
  windowStart: string;
  windowEnd: string;
}

export interface ProjectionPayloadSummaryV1 {
  monthlyMeanCents: number;
  annualScenarioCents: number;
  totalBaseCents: number;
}

/**
 * Comparação LEGADA do mês atual (pré-PESSOAL-13C4A-E3.7): referência
 * proporcional até o dia. O mapeador NUNCA gera esta forma; o sanitizador a
 * aceita SOMENTE como leitura de mensagens persistidas antigas.
 */
export interface ProjectionPayloadLegacyCurrentComparisonV1 {
  deviation: ProjectionPayloadDeviation;
  deviationCents: number;
  referenceBasis: 'expected_to_date';
  referenceCents: number;
  realizedCents: number;
  /** Esperado linear até o dia (obrigatório no legado do mês atual). */
  expectedToDateCents: number;
  /** Lançamentos futuros registrados (occurredOn > todayISO). */
  futureRegisteredCents: number;
  /** Realizado + futuros. */
  committedCents: number;
  /** Fechamento estimado: null antes do 7º dia; inteiro seguro (inclusive 0) a partir do 7º. */
  closingProjectionCents: number | null;
}

/**
 * Comparação por MÉDIA MENSAL (mês passado e mês atual novo — E3.7): a mesma
 * forma nos dois casos; apenas reference.kind diferencia.
 */
export interface ProjectionPayloadMonthlyMeanComparisonV1 {
  deviation: ProjectionPayloadDeviation;
  deviationCents: number;
  referenceBasis: 'monthly_mean';
  referenceCents: number;
  realizedCents: number;
}

export type ProjectionPayloadComparisonV1 =
  | ProjectionPayloadLegacyCurrentComparisonV1
  | ProjectionPayloadMonthlyMeanComparisonV1;

export interface ProjectionPayloadCategoryV1 {
  label: string;
  /** Média mensal nos meses cobertos. */
  monthlyMeanCents: number;
  annualScenarioCents: number;
  /** Realizado no mês atual (até hoje) ou no mês selecionado — mapeado do motor. */
  realizedCents: number;
  /** Base da comparação DA CATEGORIA: SEMPRE 'monthly_mean' (média completa) no
   * mês atual e no passado (PESSOAL-13C4A-E3.7). Categorias legadas do mês
   * atual podem carregar 'expected_to_date' apenas em leitura (pré-E3.7). */
  referenceBasis: ProjectionPayloadComparisonBasis;
  /** Modo de card da categoria (lista fechada). */
  mode: ProjectionPayloadCategoryMode;
  /** Valores comparativos mapeados direto do motor. */
  referenceCents: number;
  deviationCents: number;
  deviation: ProjectionPayloadDeviation;
  /**
   * LEITURA LEGADA (pré-E3.7) — lançamentos futuros da categoria no mês atual e
   * realizado + futuros, presentes SOMENTE em categorias de payloads legados do
   * mês atual. O mapeador novo NUNCA os emite; o sanitizador os exige em
   * payloads legados e REJEITA tanto em payloads de mês passado quanto no mês
   * atual novo (monthly_mean).
   */
  futureRegisteredCents?: number;
  committedCents?: number;
}

export interface ProjectionPayloadRemainingV1 {
  categoriesCount: number;
  monthlyMeanCents: number;
  annualScenarioCents: number;
}

/**
 * Lente ativa da projeção (PESSOAL-13C4A-E3). Apenas o NOME EXIBÍVEL: nunca
 * ids, cardinalidades, paths internos nem dados financeiros. Ausente em
 * payloads sem lente (retrocompatível).
 */
export interface ProjectionPayloadLensV1 {
  label: string;
}

export interface ProjectionPayloadReasonV1 {
  code: ProjectionPayloadReasonCode;
  coveredMonths: number;
  minimumCoveredMonths: number;
}

export interface ProjectionPayloadSuccessV1 {
  version: 1;
  status: 'success';
  intent: ProjectionPayloadIntent;
  quality: ProjectionPayloadQuality;
  reference: ProjectionPayloadReferenceV1;
  coverage: ProjectionPayloadCoverageV1;
  summary: ProjectionPayloadSummaryV1;
  comparison: ProjectionPayloadComparisonV1;
  categories: ProjectionPayloadCategoryV1[];
  remaining?: ProjectionPayloadRemainingV1;
  /** Lente ativa, quando houver (apenas rótulo de exibição). */
  lens?: ProjectionPayloadLensV1;
}

export interface ProjectionPayloadInsufficientV1 {
  version: 1;
  status: 'insufficient';
  intent: ProjectionPayloadIntent;
  quality: 'insufficient';
  reference: ProjectionPayloadReferenceV1;
  coverage: ProjectionPayloadCoverageV1;
  realizedCents: number;
  reason: ProjectionPayloadReasonV1;
}

export type ProjectionPayloadV1 =
  | ProjectionPayloadSuccessV1
  | ProjectionPayloadInsufficientV1;

// ============ Helpers do mapeador ============

const PAD2 = (v: number) => String(v).padStart(2, '0');

function monthKeyOf(ym: { year: number; month: number }): string {
  return `${ym.year}-${PAD2(ym.month)}`;
}

function referenceKindOf(basis: ProjectionBasis): ProjectionPayloadReferenceKind {
  const rm = basis.referenceMonth;
  const cm = basis.currentMonth;
  return rm.year === cm.year && rm.month === cm.month ? 'current' : 'past';
}

function coverageOf(basis: ProjectionBasis): ProjectionPayloadCoverageV1 {
  return {
    windowMonths: basis.windowMonths,
    coveredMonths: basis.coveredMonths,
    minimumCoverageMonths: MINIMUM_COVERAGE_MONTHS,
    requiredFullCoverageMonths: REQUIRED_FULL_COVERAGE_MONTHS,
    windowStart: basis.windowStart.slice(0, 7),
    windowEnd: basis.windowEnd.slice(0, 7),
  };
}

// ============ Mapeador único ============

/**
 * Converte PROJETION EngineResult para o contrato versionado. Espera o intent
 * de roteamento (um dos quatro; nunca clarification). Determinístico: nenhum
 * cálculo é replicado — apenas os agregados já prontos do motor são mapeados.
 */
export function mapProjectionToPayloadV1(
  result: ProjectionEngineResult,
  intent: ProjectionPayloadIntent,
  lensLabel?: string | null,
): ProjectionPayloadV1 {
  const reference: ProjectionPayloadReferenceV1 = {
    month: monthKeyOf(result.basis.referenceMonth),
    kind: referenceKindOf(result.basis),
  };
  const coverage = coverageOf(result.basis);

  if (result.status === 'insufficient') {
    const payload: ProjectionPayloadInsufficientV1 = {
      version: PROJECTION_PAYLOAD_VERSION,
      status: 'insufficient',
      intent,
      quality: 'insufficient',
      reference,
      coverage,
      realizedCents: result.realizedCents,
      reason: {
        code: result.reason.code,
        coveredMonths: result.reason.coveredMonths,
        minimumCoveredMonths: result.reason.minimumCoveredMonths,
      },
    };
    return payload;
  }

  const comparison: ProjectionPayloadComparisonV1 = {
    deviation: result.comparison.deviation,
    deviationCents: result.comparison.deviationCents,
    referenceBasis: 'monthly_mean',
    referenceCents: result.comparison.referenceCents,
    realizedCents: result.comparison.realizedCents,
  };

  const payload: ProjectionPayloadSuccessV1 = {
    version: PROJECTION_PAYLOAD_VERSION,
    status: 'success',
    intent,
    quality: result.quality,
    reference,
    coverage,
    summary: {
      monthlyMeanCents: result.summary.monthlyMeanCents,
      annualScenarioCents: result.summary.annualScenarioCents,
      totalBaseCents: result.summary.totalBaseCents,
    },
    comparison,
    categories: result.categories.slice(0, PROJECTION_CATEGORIES_MAX).map((c) => {
      // PESSOAL-13C4A-E3.7: nunca expõe futuros/comprometido por categoria —
      // a comparação do mês atual é pelo mês INTEIRO (monthly_mean).
      return {
        label: c.label,
        monthlyMeanCents: c.monthlyMeanCents,
        annualScenarioCents: c.annualScenarioCents,
        realizedCents: c.actualCents,
        referenceBasis: c.referenceBasis,
        mode: c.mode,
        referenceCents: c.referenceCents,
        deviationCents: c.deviationCents,
        deviation: c.deviation,
      };
    }),
  };
  if (result.remainingCategories.remainingCategoriesCount > 0) {
    payload.remaining = {
      categoriesCount: result.remainingCategories.remainingCategoriesCount,
      monthlyMeanCents: result.remainingCategories.remainingMonthlyMeanCents,
      annualScenarioCents: result.remainingCategories.remainingAnnualScenarioCents,
    };
  }
  if (typeof lensLabel === 'string' && lensLabel.trim() !== '') {
    payload.lens = { label: lensLabel.trim() };
  }
  return payload;
}

// ============ Sanitizador idempotente ============

const HTML_TAG_RE = /<[^>]*>/g;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
): T | undefined {
  if (typeof value !== 'string') return undefined;
  return (allowed as ReadonlyArray<string>).includes(value) ? (value as T) : undefined;
}

/** Inteiro seguro não negativo dentro de `max` (aceita 0 legitimamente). */
function amountValue(
  value: unknown,
  max: number = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined;
  if (value < 0 || value > max) return undefined;
  return value;
}

/** Inteiro seguro com sinal (usado em desvios, que podem ser negativos). */
function deltaValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined;
  return value;
}

function yearMonthValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || !PROJECTION_YEAR_MONTH_RE.test(value)) {
    return undefined;
  }
  return value;
}

/** Texto simples: remove HTML e caracteres de controle, trunca por segurança. */
function cleanLabel(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(HTML_TAG_RE, '').replace(CONTROL_RE, '').trim();
  if (!cleaned) return null;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function sanitizeReference(rawInput: unknown): ProjectionPayloadReferenceV1 | undefined {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return undefined;
  }
  const raw = rawInput as Record<string, unknown>;
  const month = yearMonthValue(raw.month);
  const kind = enumValue(raw.kind, PROJECTION_REFERENCE_KINDS);
  if (!month || !kind) return undefined;
  return { month, kind };
}

function sanitizeCoverage(rawInput: unknown): ProjectionPayloadCoverageV1 | undefined {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return undefined;
  }
  const raw = rawInput as Record<string, unknown>;
  const windowMonths = amountValue(raw.windowMonths, 64);
  const coveredMonths = windowMonths === undefined ? undefined : amountValue(raw.coveredMonths, windowMonths);
  const minimumCoverageMonths = amountValue(raw.minimumCoverageMonths, 12);
  const requiredFullCoverageMonths = amountValue(raw.requiredFullCoverageMonths, 12);
  const windowStart = yearMonthValue(raw.windowStart);
  const windowEnd = yearMonthValue(raw.windowEnd);
  if (
    windowMonths === undefined ||
    coveredMonths === undefined ||
    minimumCoverageMonths === undefined ||
    requiredFullCoverageMonths === undefined ||
    !windowStart ||
    !windowEnd
  ) {
    return undefined;
  }
  return {
    windowMonths,
    coveredMonths,
    minimumCoverageMonths,
    requiredFullCoverageMonths,
    windowStart,
    windowEnd,
  };
}

function sanitizeSummary(rawInput: unknown): ProjectionPayloadSummaryV1 | undefined {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return undefined;
  }
  const raw = rawInput as Record<string, unknown>;
  const monthlyMeanCents = amountValue(raw.monthlyMeanCents);
  const annualScenarioCents = amountValue(raw.annualScenarioCents);
  const totalBaseCents = amountValue(raw.totalBaseCents);
  if (
    monthlyMeanCents === undefined ||
    annualScenarioCents === undefined ||
    totalBaseCents === undefined
  ) {
    return undefined;
  }
  return { monthlyMeanCents, annualScenarioCents, totalBaseCents };
}

const PROJECTION_CURRENT_COMPARISON_FIELDS = [
  'expectedToDateCents',
  'futureRegisteredCents',
  'committedCents',
  'closingProjectionCents',
] as const;

function sanitizeComparison(
  rawInput: unknown,
  referenceKind: ProjectionPayloadReferenceKind,
): ProjectionPayloadComparisonV1 | undefined {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return undefined;
  }
  const raw = rawInput as Record<string, unknown>;
  const deviation = enumValue(raw.deviation, PROJECTION_DEVIATIONS);
  const referenceBasis = enumValue(raw.referenceBasis, PROJECTION_COMPARISON_BASIS);
  const deviationCents = deltaValue(raw.deviationCents);
  const referenceCents = amountValue(raw.referenceCents);
  const realizedCents = amountValue(raw.realizedCents);
  if (
    !deviation ||
    !referenceBasis ||
    deviationCents === undefined ||
    referenceCents === undefined ||
    realizedCents === undefined
  ) {
    return undefined;
  }

  // PESSOAL-13C4A-E3.7: expected_to_date é LEITURA LEGADA exclusiva do mês
  // atual (pré-E3.7): exige os quatro campos. O mapeador nunca a gera.
  if (referenceBasis === 'expected_to_date') {
    if (referenceKind !== 'current') return undefined;
    const expectedToDateCents = amountValue(raw.expectedToDateCents);
    const futureRegisteredCents = amountValue(raw.futureRegisteredCents);
    const committedCents = amountValue(raw.committedCents);
    let closingProjectionCents: number | null;
    if (raw.closingProjectionCents === null) {
      closingProjectionCents = null;
    } else {
      const v = amountValue(raw.closingProjectionCents);
      if (v === undefined) return undefined;
      closingProjectionCents = v;
    }
    if (
      expectedToDateCents === undefined ||
      futureRegisteredCents === undefined ||
      committedCents === undefined
    ) {
      return undefined;
    }
    return {
      deviation,
      deviationCents,
      referenceBasis,
      referenceCents,
      realizedCents,
      expectedToDateCents,
      futureRegisteredCents,
      committedCents,
      closingProjectionCents,
    };
  }

  // monthly_mean: mês passado OU mês atual NOVO (E3.7). Campos exclusivos do
  // legado do mês atual são REJEITADOS em qualquer um dos dois.
  for (const field of PROJECTION_CURRENT_COMPARISON_FIELDS) {
    if ((raw as Record<string, unknown>)[field] !== undefined) return undefined;
  }
  return {
    deviation,
    deviationCents,
    referenceBasis: 'monthly_mean',
    referenceCents,
    realizedCents,
  };
}

function sanitizeCategories(
  rawInput: unknown,
  referenceKind: ProjectionPayloadReferenceKind,
  comparisonBasis: ProjectionPayloadComparisonBasis,
): ProjectionPayloadCategoryV1[] | undefined {
  if (!Array.isArray(rawInput)) return undefined;
  // Mês atual LEGADO (comparação expected_to_date, pré-E3.7): categorias com
  // futuros/comprometido e a coerência modo ↔ base antiga. Mês atual NOVO e
  // passado: monthly_mean SEMPRE, e futuros/comprometido são REJEITADOS.
  const legacyCurrent = referenceKind === 'current' && comparisonBasis === 'expected_to_date';
  const out: ProjectionPayloadCategoryV1[] = [];
  for (const item of rawInput) {
    if (out.length >= PROJECTION_CATEGORIES_MAX) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const raw = item as Record<string, unknown>;
    const label = cleanLabel(raw.label, PROJECTION_LABEL_MAX);
    const monthlyMeanCents = amountValue(raw.monthlyMeanCents);
    const annualScenarioCents = amountValue(raw.annualScenarioCents);
    const realizedCents = amountValue(raw.realizedCents);
    const referenceBasis = enumValue(raw.referenceBasis, PROJECTION_COMPARISON_BASIS);
    const mode = enumValue(raw.mode, PROJECTION_CATEGORY_MODES);
    const referenceCents = amountValue(raw.referenceCents);
    const deviationCents = deltaValue(raw.deviationCents);
    const deviation = enumValue(raw.deviation, PROJECTION_DEVIATIONS);
    // future/committed por categoria existem SOMENTE em payloads LEGADOS do
    // mês atual (obrigatórios e numéricos lá); no mês atual novo e no passado
    // são REJEITADOS.
    const hasCurrentCategoryFields =
      raw.futureRegisteredCents !== undefined || raw.committedCents !== undefined;
    const futureRegisteredCents = amountValue(raw.futureRegisteredCents);
    const committedCents = amountValue(raw.committedCents);
    if (
      !label ||
      monthlyMeanCents === undefined ||
      annualScenarioCents === undefined ||
      realizedCents === undefined ||
      !referenceBasis ||
      !mode ||
      referenceCents === undefined ||
      deviationCents === undefined ||
      !deviation
    ) {
      return undefined;
    }
    if (legacyCurrent) {
      // Mês atual LEGADO (pré-E3.7): exige future/committed e a coerência
      // antiga modo ↔ referenceBasis.
      if (!hasCurrentCategoryFields) return undefined;
      if (futureRegisteredCents === undefined || committedCents === undefined) {
        return undefined;
      }
      if (mode === 'variable_pace') {
        if (referenceBasis !== 'expected_to_date') return undefined;
      } else if (referenceBasis !== 'monthly_mean') {
        return undefined;
      }
      out.push({
        label,
        monthlyMeanCents,
        annualScenarioCents,
        realizedCents,
        referenceBasis,
        mode,
        referenceCents,
        deviationCents,
        deviation,
        futureRegisteredCents: futureRegisteredCents as number,
        committedCents: committedCents as number,
      });
    } else {
      // Mês atual NOVO (E3.7) e mês passado: monthly_mean SEMPRE; os campos do
      // mês atual legado nunca podem ser injetados.
      if (hasCurrentCategoryFields) return undefined;
      if (referenceBasis !== 'monthly_mean') return undefined;
      out.push({
        label,
        monthlyMeanCents,
        annualScenarioCents,
        realizedCents,
        referenceBasis,
        mode,
        referenceCents,
        deviationCents,
        deviation,
      });
    }
  }
  return out;
}

function sanitizeRemaining(rawInput: unknown): ProjectionPayloadRemainingV1 | undefined {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return undefined;
  }
  const raw = rawInput as Record<string, unknown>;
  const categoriesCount = amountValue(raw.categoriesCount, 1000);
  const monthlyMeanCents = amountValue(raw.monthlyMeanCents);
  const annualScenarioCents = amountValue(raw.annualScenarioCents);
  if (
    categoriesCount === undefined ||
    monthlyMeanCents === undefined ||
    annualScenarioCents === undefined
  ) {
    return undefined;
  }
  return { categoriesCount, monthlyMeanCents, annualScenarioCents };
}

function sanitizeReason(rawInput: unknown): ProjectionPayloadReasonV1 | undefined {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return undefined;
  }
  const raw = rawInput as Record<string, unknown>;
  const code = enumValue(raw.code, PROJECTION_REASON_CODES);
  const coveredMonths = amountValue(raw.coveredMonths, 64);
  const minimumCoveredMonths = amountValue(raw.minimumCoveredMonths, 12);
  if (!code || coveredMonths === undefined || minimumCoveredMonths === undefined) {
    return undefined;
  }
  return { code, coveredMonths, minimumCoveredMonths };
}

/** Lente: apenas rótulo de exibição limpo (nunca ids/paths). Estruturalmente inválido → undefined. */
function sanitizeLens(rawInput: unknown): ProjectionPayloadLensV1 | undefined {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return undefined;
  }
  const label = cleanLabel((rawInput as Record<string, unknown>).label, PROJECTION_LENS_LABEL_MAX);
  if (!label) return undefined;
  return { label };
}

/**
 * Sanitiza um payload de projeção desconhecido para a forma versionada. Qualquer
 * violação estrutural ou de allowlist → undefined (nunca objeto parcial). O
 * resultado é idempotente: campos desconhecidos/injetados são descartados em
 * todos os níveis, sem expor IDs, perguntas, descrições, transações, contas ou
 * objetos Supabase.
 */
export function sanitizeProjectionPayloadV1(input: unknown): ProjectionPayloadV1 | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  if (raw.version !== PROJECTION_PAYLOAD_VERSION) return undefined;

  const intent = enumValue(raw.intent, PROJECTION_INTENTS);
  if (!intent) return undefined;
  const reference = sanitizeReference(raw.reference);
  if (!reference) return undefined;
  const coverage = sanitizeCoverage(raw.coverage);
  if (!coverage) return undefined;

  if (raw.status === 'insufficient') {
    if (raw.quality !== 'insufficient') return undefined;
    const realizedCents = amountValue(raw.realizedCents);
    const reason = sanitizeReason(raw.reason);
    if (realizedCents === undefined || !reason) return undefined;
    const payload: ProjectionPayloadInsufficientV1 = {
      version: PROJECTION_PAYLOAD_VERSION,
      status: 'insufficient',
      intent,
      quality: 'insufficient',
      reference,
      coverage,
      realizedCents,
      reason,
    };
    return payload;
  }

  if (raw.status === 'success') {
    const quality = enumValue(raw.quality, PROJECTION_QUALITIES);
    if (!quality) return undefined;
    const summary = sanitizeSummary(raw.summary);
    const comparison = sanitizeComparison(raw.comparison, reference.kind);
    const categories =
      comparison === undefined
        ? undefined
        : sanitizeCategories(raw.categories, reference.kind, comparison.referenceBasis);
    if (!summary || !comparison || categories === undefined) return undefined;
    const payload: ProjectionPayloadSuccessV1 = {
      version: PROJECTION_PAYLOAD_VERSION,
      status: 'success',
      intent,
      quality,
      reference,
      coverage,
      summary,
      comparison,
      categories,
    };
    if (raw.remaining !== undefined) {
      const remaining = sanitizeRemaining(raw.remaining);
      if (!remaining) return undefined;
      payload.remaining = remaining;
    }
    if (raw.lens !== undefined) {
      const lens = sanitizeLens(raw.lens);
      if (!lens) return undefined;
      payload.lens = lens;
    }
    return payload;
  }

  return undefined;
}
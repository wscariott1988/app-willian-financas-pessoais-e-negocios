// types.ts — Tipos compartilhados finance-ai (PESSOAL-13B1).
// Lógica pura; sem I/O, sem browser, sem secrets.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Content } from '@google/genai';
import type { ProjectionPayloadV1 } from './projectionPayloadV1.js';

// ── Tool registry ──────────────────────────────────────────────

export type ToolArgType = 'string' | 'number' | 'boolean';

export interface ToolArgDef {
  type: ToolArgType;
  description: string;
  required?: boolean;
}

export interface ToolArgSchema {
  [key: string]: ToolArgDef;
}

export interface FinanceTool {
  name: string;
  description: string;
  argSchema: ToolArgSchema;
  execute: (
    supabase: SupabaseClient,
    args: Record<string, unknown>,
    todayISO: string,
  ) => Promise<unknown>;
}

// ── Tool result wrappers ───────────────────────────────────────

export interface ToolResultSummary {
  income: number;
  expense: number;
  balance: number;
  totalCount: number;
  expenseShare: number | null;
}

export interface ToolResultCategory {
  label: string;
  amount: number;
  share: number;
}

export interface ToolResultMonthlyPoint {
  key: string;
  label: string;
  income: number;
  expense: number;
  balance: number;
}

export interface ToolResultPaidVsForecast {
  paid: number;
  unpaid: number;
  total: number;
  outsideStatusWindow: number;
}

export interface ToolResultInstallmentItem {
  displayName: string;
  remaining: number;
  nextDate: string | null;
  amount: number;
}

export interface ToolResultInstallment {
  count: number;
  committed: number;
  items: ToolResultInstallmentItem[];
  finishingSoon: ToolResultInstallmentItem[];
}

export interface ToolResultRecurringItem {
  displayName: string;
  frequencyLabel: string | null;
  nextDate: string | null;
  amount: number;
}

export interface ToolResultRecurring {
  count: number;
  items: ToolResultRecurringItem[];
}

export interface ToolResultTopExpense {
  description: string;
  category: string;
  amount: number;
  occurredOn: string;
}

export interface ToolResultSearchRow {
  date: string;
  description: string;
  category: string;
  account: string;
  type: string;
  amount: number;
  status: string;
}

export interface ToolExpenseMonthPoint {
  key: string; // 'YYYY-MM'
  monthLabel: string; // 'março de 2026'
  amount: number;
  count: number;
}

export interface ToolResultExpenseMonthlyAggregate {
  hasData: boolean;
  /** Sempre 'expense' (receitas e transferências são excluídas). */
  kind: 'expense';
  categoryFiltered: boolean;
  matchedCategory: string | null;
  /** Intervalo Efetivamente consultado pela ferramenta (não o filtro da tela). */
  periodAnalyzed: { start: string; end: string };
  months: ToolExpenseMonthPoint[];
  winnerMonths: Array<{ key: string; monthLabel: string }>;
  winnerAmount: number;
  winnerCount: number;
  totalAmount: number;
  totalCount: number;
}

// ── Gemini client abstraction ──────────────────────────────────

export interface GeminiFunctionResult {
  /** id exatamente correspondente à functionCall original (PESSOAL-13B3.11). */
  id?: string;
  /** nome exatamente correspondente à functionCall original. */
  name: string;
  /** JSON serializado do resultado da ferramenta correspondente. */
  parts: string;
}

export interface GeminiMessage {
  role: 'user' | 'model' | 'function';
  parts: string;
  functionName?: string;
  /** id da functionCall original, propagado ao functionResponse correspondente (PESSOAL-13B3.9). */
  id?: string;
  /** Lote de results de um turno do modelo com N functionCalls. Vira um único Content role:'user' com N functionResponse parts (PESSOAL-13B3.11). */
  responses?: GeminiFunctionResult[];
  /** Content original do SDK preservado integralmente para continuidade de function calling. */
  content?: Content;
}

export interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
  /** id único da functionCall quando fornecido pelo provedor. */
  id?: string;
}

export interface GeminiResponse {
  text: string;
  functionCalls: GeminiFunctionCall[];
  /** Content completo do candidato selecionado (parts, functionCall, id, thoughtSignature) preservado. */
  sdkContent?: Content;
}

export interface GeminiClient {
  sendMessage(messages: GeminiMessage[]): Promise<GeminiResponse>;
}

// ── Request / Response ─────────────────────────────────────────

export interface AskRequest {
  question: string;
  period?: { start: string; end: string };
  /** Chat persistente (PESSOAL-13C2): id da conversa; exige clientRequestId. */
  conversationId?: string;
  /** Idempotência por tentativa: mesmo id sob a mesma conversa não é reprocessado. */
  clientRequestId?: string;
}

export interface EvidenceItem {
  label: string;
  value: string;
}

/** Motor que produziu a resposta (PESSOAL-13C1). */
export type AskEngine = 'deterministic' | 'gemini';

// ── Cards temáticos determinísticos (PESSOAL-13C3B-E2) ─────────

export type TrendCardKind = 'growth' | 'new' | 'spike' | 'savings';

export interface TrendCardRow {
  label: string;
  value: string;
}

export interface TrendCard {
  kind: TrendCardKind;
  title: string;
  subtitle: string;
  rows: TrendCardRow[];
}

export interface AskResponse {
  answer: string;
  period: { start: string; end: string } | null;
  toolsUsed: string[];
  evidence?: EvidenceItem[];
  /** 'deterministic' quando respondido sem nenhuma chamada ao Gemini. */
  engine?: AskEngine;
  /** Quantidade de chamadas sendMessage ao Gemini nesta requisição (0 em determinístico). */
  geminiCallCount?: number;
  /** Período EFETIVAMENTE consultado pelo backend (igual a `period` aqui; badge da tela). */
  periodAnalyzed?: { start: string; end: string };
  /** Cards temáticos (tendências / oportunidades de economia) — opcional e retrocompatível. */
  cards?: TrendCard[];
  /** Aviso adicional (ex.: simulação de redução) — opcional e retrocompatível. */
  notice?: string;
  /**
   * Payload de projeção JÁ SANITIZADO (PESSOAL-13C4A-E2): presente somente em
   * turnos de projeção reais (projection_base/current_month/month_comparison/
   * categories) com quality full/preliminary ou insufficient. NUNCA em
   * clarification nem em falha de infraestrutura (HTTP ≠ 200). Idêntico entre
   * resposta fresca, cache/idempotência e listMessages.
   */
  projection?: ProjectionPayloadV1;
}

// FinanceAiSection.tsx — Bloco "Pergunte às suas finanças" dentro de Análises
// (PESSOAL-13B1). Mobile-first; sem estado de chatbot persistente. Bloqueia
// envio duplicado enquanto a requisição está ativa e desativa sugestões durante
// o envio. Nunca expõe config técnica/secrets para o usuário final.

import { useState, useRef } from 'react';
import { Sparkles, Send, Loader2, AlertCircle, Bot, ShieldCheck } from 'lucide-react';
import {
  askFinance,
  FinanceApiError,
  type AskApiResponse,
} from '../lib/financeAiClient';

const SUGGESTIONS = [
  'Onde estou gastando mais?',
  'Compare com o mês passado',
  'Quanto ainda tenho para pagar?',
  'Quais são meus maiores gastos?',
];

export interface FinanceAiSectionProps {
  period?: { start: string; end: string };
}

export function FinanceAiSection({ period }: FinanceAiSectionProps) {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskApiResponse | null>(null);
  const inFlight = useRef(false);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await askFinance({ question: q, period: period ?? undefined });
      setResult(response);
    } catch (err) {
      if (err instanceof FinanceApiError) {
        setError(err.message);
      } else {
        setError('Não foi possível responder agora. Tente novamente.');
      }
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(question);
  };

  const formatPeriod = (p: { start: string; end: string }): string => {
    const d = (v: string) => v.split('-').reverse().join('/');
    return `${d(p.start)} a ${d(p.end)}`;
  };

  return (
    <section className="analytics-section finance-ai-section" aria-label="Pergunte às suas finanças">
      <h2 className="analytics-section-title">
        <Sparkles size={15} /> Pergunte às suas finanças
      </h2>

      <form className="finance-ai-form" onSubmit={handleSubmit}>
        <textarea
          className="finance-ai-input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ex.: Onde estou gastando mais neste mês?"
          rows={3}
          maxLength={1000}
          disabled={loading}
          aria-label="Sua pergunta sobre as finanças"
        />
        <button
          type="submit"
          className="finance-ai-submit"
          disabled={loading || !question.trim()}
          aria-busy={loading}
        >
          {loading ? <Loader2 size={16} className="spin-animation" /> : <Send size={16} />}
          <span>{loading ? 'Analisando…' : 'Perguntar'}</span>
        </button>
      </form>

      {!loading && !result && !error && (
        <div className="finance-ai-suggestions" role="group" aria-label="Sugestões de perguntas">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="finance-ai-chip"
              onClick={() => {
                setQuestion(s);
                void send(s);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="analytics-state finance-ai-loading">
          <Bot size={16} /> Consultando suas finanças…
        </div>
      )}

      {error && (
        <div className="analytics-error" role="alert">
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="finance-ai-result">
          {result.period && (
            <div className="finance-ai-period">
              <ShieldCheck size={13} /> Período analisado: {formatPeriod(result.period)}
            </div>
          )}
          <p className="finance-ai-answer">{result.answer}</p>
          {result.evidence && result.evidence.length > 0 && (
            <ul className="finance-ai-evidence">
              {result.evidence.map((item, i) => (
                <li key={`${item.label}-${i}`}>
                  <span className="finance-ai-evidence-label">{item.label}</span>
                  <span className="finance-ai-evidence-value">{item.value}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="finance-ai-meta">
            Análise gerada com base nos seus dados do período; transferências não são
            consideradas receita ou despesa.
          </p>
        </div>
      )}
    </section>
  );
}
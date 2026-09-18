// FinanceAiSection.tsx — Bloco "Pergunte às suas finanças" dentro de Análises
// (PESSOAL-13B1 + PESSOAL-13C2: chat persistente). Mobile-first.
//
// PESSOAL-13C2:
//   - histórico de conversas por perfil (RLS), nova conversa, excluir com
//     confirmação, Enter envia / Shift+Enter quebra linha, paginação da
//     timeline (página mais recente primeiro) e idempotência de envio
//     (clientRequestId + inFlight, sem duplicar no servidor);
//   - mensagens otimistas são reconciliadas pelo clientRequestId com o que o
//     servidor persistiu (UNIQUE(conversation_id, client_request_id));
//   - a lógica de mudança de estado vive em src/lib/chatState (reducer puro).
//
// PESSOAL-13C2B.6:
//   - hidratação real no mount: listConversations → conversations_loaded →
//     auto-seleção da conversa mais recente → listMessages → messages_loaded;
//   - corridas: a hidratação lenta nunca apaga conversa criada/selecionada pelo
//     usuário no intervalo (merge com itens locais + guarda hydrateActedRef) e
//     nunca despacha após unmount (mountedRef + AbortController no cleanup),
//     com suporte a React StrictMode (dispatches cancelados no primeiro run);
//   - conversa recém-criada entra na sidebar imediatamente (conversation_upserted
//     com id canônico do servidor) e cada resposta atualiza lastMessageAt e move
//     para o topo sem duplicar;
//   - falha de LEITURA vira mensagem amigável de carregamento (nunca "lista
//     vazia" nem "Serviço de inteligência indisponível").
//
// Regras invariantes mantidas: nunca expõe config técnica/secrets para o
// usuário final; o perfil da conversa nunca vem do cliente (RLS decide).

import { useEffect, useReducer, useRef, useState } from 'react';
import {
  Sparkles,
  Send,
  Loader2,
  AlertCircle,
  Bot,
  ShieldCheck,
  Plus,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import {
  askFinance,
  FinanceApiError,
} from '../lib/financeAiClient';
import {
  chatReducer,
  createChatState,
  shouldSendOnEnter,
  uiTitleFor,
  mergeServerConversationList,
  type ChatConversationItem,
  type ChatUiState,
  type SentPayload,
  type UiMessage,
} from '../lib/chatState';
import * as chatApi from '../lib/chatApi';

const SUGGESTIONS = [
  'Onde estou gastando mais?',
  'Compare com o mês passado',
  'Quanto ainda tenho para pagar?',
  'Quais são meus maiores gastos?',
];

export interface FinanceAiSectionProps {
  period?: { start: string; end: string };
}

function messageError(err: unknown): string {
  if (err instanceof FinanceApiError) return err.message;
  return 'Não foi possível responder agora. Tente novamente.';
}

function formatPeriod(p?: { start: string; end: string } | null): string {
  if (!p) return '';
  const d = (v: string) => v.split('-').reverse().join('/');
  return `${d(p.start)} a ${d(p.end)}`;
}

function engineLabel(m: UiMessage): string | null {
  if (m.engine === 'deterministic') {
    return 'Resposta instantânea calculada a partir dos seus dados (IA não foi acionada).';
  }
  if (m.engine) {
    return 'Resposta gerada pela inteligência artificial a partir dos seus dados.';
  }
  return null;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'growth':
      return 'Crescimento';
    case 'new':
      return 'Novo no período recente';
    case 'spike':
      return 'Pico pontual';
    case 'savings':
      return 'Oportunidade potencial para revisar';
    default:
      return kind;
  }
}

export function FinanceAiSection({ period }: FinanceAiSectionProps) {
  const [chat, dispatch] = useReducer(chatReducer, undefined, createChatState);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PESSOAL-13C2B.6: true do mount até a hidratação assentar (sucesso ou falha).
  // Em SSR não há efeitos → nasce false para manter o contrato da C1 (as
  // sugestões visíveis no markup original); no browser nasce true e a
  // hidratação destrava a UI.
  const [hydrating, setHydrating] = useState(() => typeof window !== 'undefined');
  const inFlight = useRef(false);
  const pageRef = useRef(0);
  const cridSeq = useRef(0);
  // Verdadeiro enquanto o componente está montado; impede despacho tardio.
  const mountedRef = useRef(true);
  // Verdadeiro quando o usuário já criou/selecionou/nova conversa enquanto a
  // hidratação estava pendente — nesse caso a auto-seleção é abandonada.
  const hydrateActedRef = useRef(false);
  // Itens confirmados nesta sessão (criados no browser) e ids removidos:
  // evitam que um snapshot lento da hidratação apague/re-adicione essas linhas.
  const sessionLocalsRef = useRef<Map<string, ChatConversationItem>>(new Map());
  const sessionRemovedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadMessages = async (
    conversationId: string,
    page: number,
    signal?: AbortSignal,
  ) => {
    const { messages, hasMore } = await chatApi.listMessages(
      conversationId,
      page,
      signal,
    );
    if (!mountedRef.current) return;
    dispatch(
      page === 0
        ? { type: 'messages_loaded', messages, hasMore }
        : { type: 'older_loaded', messages, hasMore },
    );
  };

  const openConversation = async (id: string, signal?: AbortSignal) => {
    hydrateActedRef.current = true;
    pageRef.current = 0;
    dispatch({ type: 'select', id });
    try {
      await loadMessages(id, 0, signal);
    } catch (err) {
      if (!mountedRef.current || signal?.aborted) return;
      dispatch({ type: 'fail', message: messageError(err) });
    }
  };

  const handleNewChat = () => {
    hydrateActedRef.current = true;
    pageRef.current = 0;
    dispatch({ type: 'new_chat' });
    setQuestion('');
  };

  const handleDeleteClick = (id: string) => {
    dispatch({ type: 'delete_confirm', id });
  };

  const handleDeleteConfirm = async (id: string) => {
    try {
      await chatApi.deleteConversation(id);
      sessionLocalsRef.current.delete(id);
      sessionRemovedRef.current.add(id);
      dispatch({ type: 'deleted', id });
      if (chat.activeId === id) setQuestion('');
    } catch (err) {
      dispatch({ type: 'fail', message: messageError(err) });
    }
  };

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || inFlight.current) return;
    hydrateActedRef.current = true;
    inFlight.current = true;
    setLoading(true);
    setError(null);

    let targetId = chat.activeId;
    try {
      if (targetId === null) {
        const created = await chatApi.createConversation();
        // PESSOAL-13C2B.6: a conversa recém-criada entra na sidebar imediatamente
        // (id canônico retornado pelo servidor), antes mesmo da resposta chegar.
        const item: ChatConversationItem = {
          id: created.id,
          title: uiTitleFor(q),
          lastMessageAt: new Date().toISOString(),
        };
        sessionLocalsRef.current.set(created.id, item);
        dispatch({ type: 'conversation_upserted', conversation: item });
        dispatch({ type: 'select', id: created.id });
        targetId = created.id;
      }
    } catch (err) {
      setError(messageError(err));
      inFlight.current = false;
      setLoading(false);
      return;
    }

    const crid = `c${Date.now()}-${++cridSeq.current}`;
    dispatch({ type: 'send_start', clientRequestId: crid, question: q });
    setQuestion('');

    const payload: SentPayload = { answer: '' };
    try {
      const response = await askFinance({
        question: q,
        period: period ?? undefined,
        conversationId: targetId,
        clientRequestId: crid,
      });
      payload.answer = response.answer;
      payload.engine = response.engine;
      payload.periodAnalyzed = response.periodAnalyzed ?? response.period ?? undefined;
      payload.evidence = response.evidence ?? undefined;
      payload.cards = response.cards ?? undefined;
      payload.notice = response.notice ?? undefined;
      dispatch({ type: 'send_success', clientRequestId: crid, payload });
      // PESSOAL-13C2B.6: resposta concluída → atualiza lastMessageAt e move a
      // conversa para o topo da sidebar (título é PRESERVADO pelo reducer).
      const now = new Date().toISOString();
      const previous = sessionLocalsRef.current.get(targetId);
      sessionLocalsRef.current.set(targetId, {
        id: targetId,
        title: previous?.title ?? uiTitleFor(q),
        lastMessageAt: now,
      });
      dispatch({
        type: 'conversation_upserted',
        conversation: { id: targetId, lastMessageAt: now },
      });
    } catch (err) {
      dispatch({
        type: 'send_error',
        clientRequestId: crid,
        message: messageError(err),
      });
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(question);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSendOnEnter(e.key, e.shiftKey)) {
      e.preventDefault();
      void send(question);
    }
  };

  const handleChip = (s: string) => {
    setQuestion(s);
    void send(s);
  };

  const retryMessage = (clientRequestId: string) => {
    for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
      const m = chat.messages[i];
      if (m.role === 'user') {
        void send(m.text);
        break;
      }
    }
    void clientRequestId;
  };

  const loadOlder = () => {
    if (!chat.activeId) return;
    const next = pageRef.current + 1;
    pageRef.current = next;
    void loadMessages(chat.activeId, next);
  };

  // PESSOAL-13C2B.6 — hidratação real no mount/remount (F5, login, troca de
  // perfil via key={profileId}). Cleanup aborta a leitura e guards impedem
  // despacho pós-unmount (mountedRef) e sobrescrita de trabalho do usuário
  // (merge com itens locais + hydrateActedRef + sessionRemovedRef).
  useEffect(() => {
    const ac = new AbortController();
    const run = async () => {
      let convs: ChatConversationItem[];
      try {
        convs = await chatApi.listConversations(ac.signal);
      } catch {
        if (!mountedRef.current || ac.signal.aborted) return;
        const msg =
          'Não foi possível carregar suas conversas. Verifique sua conexão e tente novamente.';
        setError(msg);
        dispatch({ type: 'fail', message: msg });
        setHydrating(false);
        return;
      }
      if (!mountedRef.current || ac.signal.aborted) return;

      const local = [...sessionLocalsRef.current.values()];
      const merged =
        local.length > 0 || sessionRemovedRef.current.size > 0
          ? mergeServerConversationList(convs, local, sessionRemovedRef.current)
          : convs;
      dispatch({ type: 'conversations_loaded', conversations: merged });

      if (hydrateActedRef.current || merged.length === 0) {
        if (mountedRef.current) setHydrating(false);
        return;
      }
      await openConversation(merged[0].id, ac.signal);
      if (mountedRef.current) setHydrating(false);
    };
    void run();
    return () => {
      ac.abort();
    };
  }, []);

  return (
    <section className="analytics-section finance-ai-section" aria-label="Pergunte às suas finanças">
      <h2 className="analytics-section-title">
        <Sparkles size={15} /> Pergunte às suas finanças
      </h2>

      <div className="finance-ai-layout">
        <aside className="finance-ai-chats" aria-label="Histórico de conversas">
          <button
            type="button"
            className="finance-ai-new-chat"
            onClick={handleNewChat}
            aria-label="Nova conversa"
          >
            <Plus size={15} /> Nova conversa
          </button>
          {hydrating && (
            <div className="finance-ai-chat-loading" role="status">
              <Loader2 size={13} className="spin-animation" /> Carregando
              conversas…
            </div>
          )}
          <ul className="finance-ai-chat-list">
            {chat.conversations.map((c) => (
              <li key={c.id} className="finance-ai-chat-item">
                <button
                  type="button"
                  className={
                    chat.activeId === c.id
                      ? 'finance-ai-chat-open is-active'
                      : 'finance-ai-chat-open'
                  }
                  onClick={() => void openConversation(c.id)}
                  aria-label={`Abrir conversa: ${c.title || 'Sem título'}`}
                  title={c.title || 'Sem título'}
                >
                  {c.title || 'Sem título'}
                </button>
                {chat.confirmDeleteId === c.id ? (
                  <span className="finance-ai-delete-confirm">
                    <button
                      type="button"
                      onClick={() => void handleDeleteConfirm(c.id)}
                      aria-label="Confirmar exclusão da conversa"
                    >
                      Excluir
                    </button>
                    <button
                      type="button"
                      onClick={() => dispatch({ type: 'delete_confirm', id: null })}
                      aria-label="Cancelar exclusão da conversa"
                    >
                      Cancelar
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="finance-ai-chat-delete"
                    onClick={() => handleDeleteClick(c.id)}
                    aria-label={`Excluir conversa: ${c.title || 'Sem título'}`}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </aside>

        <div className="finance-ai-main">
          <div className="finance-ai-messages" aria-live="polite">
            {chat.status === 'loading' && chat.messages.length === 0 && (
              <div className="analytics-state finance-ai-loading">
                <Bot size={16} /> Carregando conversa…
              </div>
            )}

            {hydrating &&
              chat.activeId === null &&
              chat.messages.length === 0 &&
              !error && (
                <div className="analytics-state finance-ai-loading">
                  <Loader2 size={16} className="spin-animation" /> Carregando suas
                  conversas…
                </div>
              )}

            {chat.hasMore && chat.activeId !== null && chat.messages.length > 0 && (
              <button type="button" className="finance-ai-chip finance-ai-older" onClick={loadOlder}>
                Ver mensagens anteriores
              </button>
            )}

            {chat.messages.map((m) => {
              if (m.role === 'user') {
                return (
                  <div key={m.key} className="finance-ai-msg is-user">
                    <div className="finance-ai-bubble">{m.text}</div>
                  </div>
                );
              }
              if (m.status === 'failed') {
                return (
                  <div key={m.key} className="finance-ai-msg is-assistant">
                    <div className="finance-ai-bubble finance-ai-bubble-error" role="alert">
                      <AlertCircle size={15} /> {m.error ?? 'Não foi possível responder agora.'}
                    </div>
                    <button
                      type="button"
                      className="finance-ai-retry"
                      onClick={() => retryMessage(m.clientRequestId ?? m.key)}
                      aria-label="Tentar novamente"
                    >
                      <RotateCcw size={13} /> Tentar novamente
                    </button>
                  </div>
                );
              }
              return (
                <div key={m.key} className="finance-ai-msg is-assistant">
                  <div
                    className={
                      m.status === 'pending'
                        ? 'finance-ai-bubble finance-ai-bubble-pending'
                        : 'finance-ai-bubble'
                    }
                  >
                    {m.periodAnalyzed && m.status === 'completed' && (
                      <div className="finance-ai-period">
                        <ShieldCheck size={13} /> Período analisado:{' '}
                        {formatPeriod(m.periodAnalyzed)}
                      </div>
                    )}
                     {m.status === 'pending' ? (
                       <p className="finance-ai-answer finance-ai-pending-text">
                         <Loader2 size={15} className="spin-animation" /> Consultando
                         suas finanças…
                       </p>
                     ) : (
                       <p className="finance-ai-answer">{m.text}</p>
                     )}
                     {m.cards && m.cards.length > 0 && m.status === 'completed' && (
                       <section className="finance-ai-cards-section" aria-label="Cards analíticos de tendências e oportunidades">
                         <ul className="finance-ai-cards-list">
                           {m.cards.map((card, ci) => (
                             <li key={`${card.kind}-${card.title}-${ci}`} className="finance-ai-card-item">
                               <article className={`finance-ai-trend-card finance-ai-card-${card.kind}`}>
                                 <div className="finance-ai-card-badge">{kindLabel(card.kind)}</div>
                                 <h3 className="finance-ai-card-title">{card.title}</h3>
                                 {card.subtitle ? (
                                   <p className="finance-ai-card-subtitle">{card.subtitle}</p>
                                 ) : null}
                                 {card.rows && card.rows.length > 0 ? (
                                   <dl className="finance-ai-card-dl">
                                     {card.rows.map((row, ri) => (
                                       <div key={`${row.label}-${ri}`} className="finance-ai-card-row">
                                         <dt className="finance-ai-card-dt">{row.label}</dt>
                                         <dd className="finance-ai-card-dd">{row.value}</dd>
                                       </div>
                                     ))}
                                   </dl>
                                 ) : null}
                               </article>
                             </li>
                           ))}
                         </ul>
                       </section>
                     )}
                     {(!m.cards || m.cards.length === 0) && m.evidence && m.evidence.length > 0 && m.status === 'completed' && (
                       <ul className="finance-ai-evidence">
                         {m.evidence.map((item, i) => (
                           <li key={`${item.label}-${i}`}>
                             <span className="finance-ai-evidence-label">{item.label}</span>
                             <span className="finance-ai-evidence-value">{item.value}</span>
                           </li>
                         ))}
                       </ul>
                     )}
                     {m.notice && m.notice.trim() !== '' && m.status === 'completed' && (
                       <div className="finance-ai-notice" role="note">
                         {m.notice}
                       </div>
                     )}
                    {engineLabel(m) && m.status === 'completed' && (
                      <p className="finance-ai-engine" data-engine={m.engine}>
                        {engineLabel(m)}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {chat.activeId === null &&
            chat.messages.length === 0 &&
            !error &&
            !hydrating && (
              <div
                className="finance-ai-suggestions"
                role="group"
                aria-label="Sugestões de perguntas"
              >
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="finance-ai-chip"
                  onClick={() => handleChip(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {error && (
            <div className="analytics-error" role="alert">
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '1px' }} />
              <span>{error}</span>
            </div>
          )}

          <form className="finance-ai-form" onSubmit={handleSubmit}>
            <textarea
              className="finance-ai-input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ex.: E em maio, quanto gastei no supermercado?"
              rows={3}
              maxLength={1000}
              disabled={loading}
              aria-label="Sua pergunta sobre as finanças"
            />
            <p className="finance-ai-key-hint">Enter envia · Shift+Enter quebra linha</p>
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
          <p className="finance-ai-meta">
            Análise gerada com base nos seus dados; transferências não são consideradas
            receita ou despesa.
          </p>
        </div>
      </div>
    </section>
  );
}
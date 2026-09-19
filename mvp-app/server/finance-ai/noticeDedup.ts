// noticeDedup.ts — PESSOAL-13C3B.21.
//
// Deduplicação PURA dos nomes de categorias exibidos no notice de exclusões
// ("compromissos fixos/dívidas, saúde, investimentos"). Vale SOMENTE para a
// APRESENTAÇÃO: nunca soma, funde, exclui nem reclassifica registros
// financeiros — a chave de equivalência é derivada apenas do texto do nome.
//
// Chave de equivalência: segmento curto relevante da categoria em lowercase,
// sem acentos, com espaços/pontuação normalizados e desprezando artigos e
// preposições isolados (de, da, do, das, dos, a, o, as, os). Sempre por
// PALAVRAS INTEGRAIS na ordem do nome — nunca substring solta. Ex.:
//   "Seguro do Carro" % "seguro carro" → mesma chave ("seguro carro");
//   "Seguro do Carro" % "Seguro Residencial" → chaves distintas.

/** Artigos/preposições isolados ignorados na chave de equivalência. */
const EQUIV_STOP_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'a', 'o', 'as', 'os']);

/**
 * Chave canônica de um nome exibível PARA DEDUPLICAÇÃO (nunca para dados).
 * Lowercase → sem acentos (NFD) → tokens por caracteres não alfanuméricos →
 * descarta artigos/preposições isolados → junta com espaço único.
 */
export function equivalenceKeyOf(name: string): string {
  const tokens = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !EQUIV_STOP_WORDS.has(t));
  return tokens.join(' ');
}

/**
 * Representante preferido entre variantes de MESMA chave, na ordem: acentuação
 * correta (mais letras acentuadas), capitalização adequada (nome iniciado por
 * maiúscula), forma mais descritiva (mais palavras) e tipografia equilibrada
 * (menos maiúsculas no meio do nome). Desempate por ordem de code units —
 * estável e determinística em qualquer runtime.
 */
export function betterDisplayName(a: string, b: string): string {
  const startsUppercase = (word: string): boolean => {
    const first = word.charAt(0);
    return first === first.toUpperCase() && first !== first.toLowerCase();
  };
  const score = (s: string): readonly [number, number, number, number] => {
    const words = s.trim().split(/\s+/).filter((w) => w.length > 0);
    const accentCount = (s.match(/[\u0300-\u036f]/g) ?? []).length;
    const capitalStart = words.length > 0 && startsUppercase(words[0]) ? 1 : 0;
    const midCapitals = words.slice(1).filter((w) => startsUppercase(w)).length;
    return [accentCount, capitalStart, words.length, -midCapitals];
  };
  const sa = score(a);
  const sb = score(b);
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] > sb[i]) return a;
    if (sb[i] > sa[i]) return b;
  }
  return a < b ? a : b;
}

/**
 * Deduplica nomes PARA A EXIBIÇÃO no notice. Preserva a ordem da primeira
 * ocorrência de cada grupo equivalente e, dentro do grupo, mantém o nome mais
 * informativo/legível (determinístico). Nenhum dado financeiro é alterado.
 */
export function dedupeDisplayNames(names: readonly string[]): string[] {
  const representative = new Map<string, string>();
  const out: string[] = [];
  for (const name of names) {
    const key = equivalenceKeyOf(name);
    const current = representative.get(key);
    if (current === undefined) {
      representative.set(key, name);
      out.push(name);
    } else {
      const best = betterDisplayName(name, current);
      if (best !== current) {
        const idx = out.indexOf(current);
        out[idx] = best;
        representative.set(key, best);
      }
    }
  }
  return out;
}
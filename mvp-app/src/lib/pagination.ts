// pagination.ts — Busca paginada genérica via .range(from, to).
// O Supabase limita as linhas retornadas por requisição; esta função percorre
// todas as páginas até esgotar o total (count=exact). Qualquer erro de página
// aborta a busca inteira — nunca devolve resultado parcial como completo.

export interface Page {
  rows: unknown[] | null;
  totalCount: number | null;
  error: Error | null;
}

export type PageFetcher = (from: number, to: number) => Promise<Page>;

export async function fetchAllPages<T>(
  fetcher: PageFetcher,
  pageSize: number,
): Promise<{ rows: T[]; totalCount: number }> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error('pageSize deve ser um inteiro maior que zero');
  }

  const rows: T[] = [];
  let totalCount: number | null = null;
  let from = 0;

  for (;;) {
    const page = await fetcher(from, from + pageSize - 1);
    if (page.error) throw page.error;

    const pageRows = page.rows ?? [];
    totalCount = page.totalCount ?? totalCount;
    rows.push(...(pageRows as T[]));

    if (totalCount !== null) {
      if (rows.length >= totalCount) break;
      if (pageRows.length === 0) {
        throw new Error(
          `página vazia antes do total esperado (${rows.length}/${totalCount}) — consulta abortada`,
        );
      }
    } else if (pageRows.length < pageSize || pageRows.length === 0) {
      break;
    }

    from += pageSize;
  }

  return { rows, totalCount: totalCount ?? rows.length };
}

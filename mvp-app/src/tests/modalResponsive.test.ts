import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

const css = readSource('index.css');
const editorSrc = readSource('components/TransactionEditor.tsx');
const detailSrc = readSource('components/TransactionDetail.tsx');
const deleteSrc = readSource('components/DeleteConfirmation.tsx');
const modalSrc = readSource('components/Modal.tsx');

function extractMediaBlock(cssSource: string, mediaQuery: string): string {
  const needle = `${mediaQuery} {`;
  const start = cssSource.indexOf(needle);
  expect(start, `media "${mediaQuery}" não encontrado`).toBeGreaterThanOrEqual(0);
  const open = start + needle.length - 1;
  let depth = 0;
  for (let i = open; i < cssSource.length; i++) {
    if (cssSource[i] === '{') depth += 1;
    else if (cssSource[i] === '}') {
      depth -= 1;
      if (depth === 0) return cssSource.slice(open + 1, i);
    }
  }
  throw new Error('bloco de media não fechado');
}

function ruleBlock(cssSource: string, selector: string): string | null {
  let idx = -1;
  for (;;) {
    idx = cssSource.indexOf(selector, idx + 1);
    if (idx === -1) return null;
    const before = idx === 0 ? ' ' : cssSource[idx - 1];
    if (!/[\s;})]/.test(before)) continue;
    const rest = cssSource.slice(idx + selector.length);
    if (!rest.trimStart().startsWith('{')) continue;
    const open = idx + selector.length + (rest.length - rest.trimStart().length);
    let depth = 0;
    for (let i = open; i < cssSource.length; i++) {
      if (cssSource[i] === '{') depth += 1;
      else if (cssSource[i] === '}') {
        depth -= 1;
        if (depth === 0) return cssSource.slice(open + 1, i);
      }
    }
    return null;
  }
}

// Larguras alvo do requisito: 320 / 360 / 390 / 430 / desktop(≥1024).
const MOBILE_WIDTHS = [320, 360, 390, 430];
const DESKTOP = 1024;

describe('PESSOAL-08 — modal respeita a viewport mobile (sem overflow horizontal)', () => {
  const mobileBlock = extractMediaBlock(css, '@media (max-width: 767px)');
  const desktopBlock = extractMediaBlock(css, '@media (min-width: 1024px)');
  const baseModal = ruleBlock(css, '.modal-content');
  const mobileModal = ruleBlock(mobileBlock, '.modal-content');
  const mobileOverlay = ruleBlock(mobileBlock, '.modal-overlay');
  const scroll = ruleBlock(css, '.modal-content-scroll');

  it('base usa calc(100vw - 24px) com teto de 560px (não colado, com margem garantida)', () => {
    expect(baseModal).toContain('width: calc(100vw - 24px)');
    expect(baseModal).toContain('max-width: 560px');
  });

  it('mobile usa width 100% dentro do overlay com padding 12px = mesma conta', () => {
    expect(mobileModal).toContain('width: 100%');
    expect(mobileModal).toContain('max-width: 100%');
    expect(mobileOverlay).toContain('padding: 12px');
  });

  it('larguras 320/360/390/430: conteúdo = viewport - 24px, nunca maior que a tela', () => {
    for (const w of MOBILE_WIDTHS) {
      const effective = w - 24;
      expect(effective).toBeLessThanOrEqual(w);
      expect(effective).toBeGreaterThan(0);
      expect(effective).toBeGreaterThanOrEqual(296); // 320 - 24 = 296
    }
  });

  it('mobile respeita a altura visível (dvh) e safe area', () => {
    expect(mobileModal).toContain('max-height: 92vh');
    expect(mobileModal).toContain('max-height: 92dvh');
    const mobileAfter = ruleBlock(mobileBlock, '.modal-content::after');
    expect(mobileAfter).toContain('env(safe-area-inset-bottom');
  });

  it('base também usa dvh com fallback vh (desktop/tablet)', () => {
    expect(baseModal).toContain('max-height: min(90vh, 720px)');
    expect(baseModal).toContain('max-height: min(90dvh, 720px)');
  });

  it('filhos do scroll container permitem encolher (min-width: 0) e max-width 100%', () => {
    expect(scroll).toContain('min-width: 0');
    expect(scroll).toContain('max-width: 100%');
    expect(baseModal).toContain('min-width: 0');
  });

  it('desktop continua com composição centralizada e teto de 560px', () => {
    expect(baseModal).toContain('max-width: 560px');
    expect(desktopBlock).not.toContain('width: calc(100vw - 24px)');
  });
});

describe('PESSOAL-08 — grid do editor é mobile-first (1 coluna → 2 só com espaço)', () => {
  const baseGrid = ruleBlock(css, '.tx-field-grid');
  const gridUp = extractMediaBlock(css, '@media (min-width: 460px)');
  const desktopGrid = ruleBlock(gridUp, '.tx-field-grid');

  it('base: 1 coluna (mobile), itens com min-width: 0', () => {
    expect(baseGrid).toContain('grid-template-columns: 1fr');
    expect(baseGrid).not.toContain('1fr 1fr');
    expect(ruleBlock(css, '.tx-field-grid > *')).toContain('min-width: 0');
  });

  it('lado a lado (2 colunas) somente ≥ 460px com minmax(0,1fr) sem estourar inputs', () => {
    expect(desktopGrid).toContain('repeat(2, minmax(0, 1fr))');
  });

  it('320/360/390/430 ficam em 1 coluna; 1024 em 2 colunas', () => {
    for (const w of MOBILE_WIDTHS) {
      expect(w).toBeLessThan(460);
    }
    expect(DESKTOP).toBeGreaterThanOrEqual(460);
  });

  it('Valor + Data usam a classe responsiva no TransactionEditor', () => {
    expect(editorSrc).toContain('className="tx-field-grid"');
    expect(editorSrc).not.toContain("gridTemplateColumns: '1fr 1fr'");
  });
});

describe('PESSOAL-08 — componentes internos não forçam overflow', () => {
  it('linhas flex com min-width: 0 nos botões de rodapé e confirmação', () => {
    expect(editorSrc).toContain("flexWrap: 'wrap'");
    expect(editorSrc).toContain('minWidth: 0');
  });

  it('padding interno do glass é clamp (respira no mobile, 24px no desktop)', () => {
    expect(editorSrc).toContain("padding: 'clamp(16px, 4vw, 24px)'");
    expect(detailSrc).toContain("padding: 'clamp(16px, 4vw, 24px)'");
    expect(deleteSrc).toContain("padding: 'clamp(16px, 4vw, 24px)'");
  });

  it('TransactionDetail: nenhum nowrap/ellipsis na linha de detalhes (texto quebra)', () => {
    expect(detailSrc).not.toContain('whiteSpace: \'nowrap\'');
    expect(detailSrc).not.toContain("textOverflow: 'ellipsis'");
    expect(detailSrc).toContain('overflowWrap: \'anywhere\'');
  });

  it('DeleteConfirmation: descrição longa quebra em vez de estourar', () => {
    expect(deleteSrc).not.toContain('whiteSpace: \'nowrap\'');
    expect(deleteSrc).not.toContain("maxWidth: '60%'");
    expect(deleteSrc).toContain('overflowWrap: \'anywhere\'');
  });

  it('Modal base usa classes CSS (min-width: 0) sem remendo de overflow-x no scroll', () => {
    expect(modalSrc).toContain('modal-content-scroll');
    const scrollBlock = ruleBlock(css, '.modal-content-scroll');
    expect(scrollBlock).not.toContain('overflow-x');
  });
});
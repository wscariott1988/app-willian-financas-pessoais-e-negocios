// pessoal13b3EsmRegression.test.ts — PESSOAL-13B3.1: regressão do carregamento
// ESM real da Function /api/finances/ask no runtime Node.
//
// Reproduz o ponto não coberto pelos testes anteriores: o grafo server-side é
// COMPILADO para JavaScript ESM (type: module) e o JavaScript emitido é
// IMPORTADO por um processo Node limpo. Qualquer import relativo sem extensão
// `.js` no grafo faz este teste falhar — ERR_MODULE_NOT_FOUND, o erro do
// runtime remoto.
//
// Regras de segurança do teste:
//   - Nenhuma chamada ao Gemini (o import do grafo é top-level, sem rede).
//   - Nenhum acesso ao Supabase (createClient é preguiçoso; nada é chamado).
//   - Nenhum secret real: o processo filho roda com variáveis sensíveis vazias.
//   - Funciona em Windows e no runtime Linux/Node (spawn do process.execPath).
//   - Os artefatos temporários são removidos no afterAll.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..', '..');
const entry = resolve(appRoot, 'api', 'finances', 'ask.ts');

const EMITTED_FILES = [
  'api/finances/ask.js',
  'server/finance-ai/orchestrator.js',
  'server/finance-ai/geminiClient.js',
  'server/finance-ai/geminiSdkClient.js',
  'server/finance-ai/toolRegistry.js',
  'server/supabaseServer.js',
  'src/lib/analyticsInsights.js',
];

let outDir: string;
let tmpRoot: string;

function makeTempDir(prefix: string): string {
  tmpRoot = join(appRoot, 'node_modules', '.tmp');
  mkdirSync(tmpRoot, { recursive: true });
  return mkdtempSync(join(tmpRoot, prefix));
}

function listJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listJsFiles(full));
    } else if (name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function compileServerGraphToEsm(dest: string): void {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: ['node'],
    skipLibCheck: true,
    esModuleInterop: true,
    verbatimModuleSyntax: true,
    noEmit: false,
    declaration: false,
    sourceMap: false,
    outDir: dest,
    rootDir: appRoot,
  };
  const program = ts.createProgram([entry], options);
  const emitResult = program.emit();
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(emitResult.diagnostics)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length > 0) {
    const detail = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => appRoot,
      getNewLine: () => '\n',
    });
    throw new Error(`Falha ao compilar o grafo server-side para ESM:\n${detail}`);
  }
  writeFileSync(
    join(dest, 'package.json'),
    JSON.stringify({ name: 'pessoal13-esm-regression', private: true, type: 'module' }, null, 2),
    'utf8',
  );
}

function importEmittedHandlerInCleanNode(dest: string): string {
  const emittedEntry = pathToFileURL(join(dest, 'api', 'finances', 'ask.js')).href;
  const script =
    `import(${JSON.stringify(emittedEntry)}).then((m) => {\n` +
    `  if (typeof m.default === 'function') { console.log('PESSOAL13_ESM_OK'); process.exit(0); }\n` +
    `  console.error('NO_DEFAULT_FUNCTION'); process.exit(2);\n` +
    `}).catch((e) => {\n` +
    `  console.error(e && e.code ? String(e.code) : String(e));\n` +
    `  console.error(e && e.message ? String(e.message) : '');\n` +
    `  process.exit(1);\n` +
    `});\n`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: appRoot,
    env: {
      ...process.env,
      GEMINI_API_KEY: '',
      GEMINI_MODEL: '',
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

beforeAll(() => {
  outDir = makeTempDir('pessoal13-esm-');
  compileServerGraphToEsm(outDir);
});

afterAll(() => {
  if (outDir && existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
});

describe('PESSOAL-13B3.1 — Regressão ESM da Function (runtime Node real)', () => {
  it('grafo server-side compila para JavaScript ESM com módulos dependentes emitidos', () => {
    for (const rel of EMITTED_FILES) {
      expect(existsSync(join(outDir, rel))).toBe(true);
    }
  });

  it('handler emitido carrega num processo Node limpo sem ERR_MODULE_NOT_FOUND', () => {
    const stdout = importEmittedHandlerInCleanNode(outDir);
    expect(stdout).toContain('PESSOAL13_ESM_OK');
  });

  it('nenhum import relativo do grafo emitido fica sem extensão .js', () => {
    const offenders: string[] = [];
    for (const file of listJsFiles(outDir)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = /from\s+['"](\.[^'"]+)['"]/.exec(lines[i]);
        if (m && !m[1].endsWith('.js')) {
          offenders.push(`${relative(outDir, file)}:${i + 1} → ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('artefatos temporários são removidos após o uso', () => {
    const scratch = makeTempDir('pessoal13-esm-clean-');
    compileServerGraphToEsm(scratch);
    expect(existsSync(join(scratch, 'api', 'finances', 'ask.js'))).toBe(true);
    expect(importEmittedHandlerInCleanNode(scratch)).toContain('PESSOAL13_ESM_OK');
    rmSync(scratch, { recursive: true, force: true });
    expect(existsSync(scratch)).toBe(false);
  });
});
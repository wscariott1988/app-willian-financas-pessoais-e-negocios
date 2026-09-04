import { chromium } from 'playwright';

const PROD_URL = 'https://app-willian-financas-pessoais-e-neg-xi.vercel.app';

let state = 'WAITING_PERSONAL_LOGIN';
let currentProfile = 'Pessoal';

const STARTUP_HTTP_ERRORS = [];
const OFFICIAL_HTTP_ERRORS = [];
const STARTUP_CONSOLE_ERRORS = [];
const OFFICIAL_CONSOLE_ERRORS = [];
const MUTATIONS = [];
const STARTUP_TRACE = [];
const OFFICIAL_TRACE = [];
const CLOSE_EVENTS = [];

let personalCompleted = false;
let businessCompleted = false;
let closeReason = 'NORMAL_SCRIPT_SHUTDOWN';

function log(category, ok, detail) {
  const tag = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'MANUAL';
  console.log(`[${tag}] ${category}: ${detail}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeTextContent(page, selector) {
  try { return await page.textContent(selector); } catch { return ''; }
}

function getPhase() {
  if (state.startsWith('PERSONAL_OFFICIAL')) return 'OFFICIAL_PERSONAL';
  if (state.startsWith('BUSINESS_OFFICIAL')) return 'OFFICIAL_BUSINESS';
  return 'STARTUP';
}

function recordRequest(req) {
  const url = req.url();
  const method = req.method();
  const headers = req.headers();
  const authPresent = !!headers['authorization'];
  const path = url.split('?')[0].replace(/^https?:\/\/[^\/]+/, '');
  const ts = new Date().toISOString();
  const isRest = url.includes('/rest/v1/');
  const isAuth = url.includes('/auth/');
  if (!isRest || isAuth) return;

  const phase = getPhase();
  const entry = { ts, method, path, authPresent, profile: currentProfile, phase, httpStatus: null };

  if (phase === 'OFFICIAL_PERSONAL' || phase === 'OFFICIAL_BUSINESS') OFFICIAL_TRACE.push(entry);
  else STARTUP_TRACE.push(entry);
}

function recordResponse(resp) {
  const status = resp.status();
  const url = resp.url();
  if (status < 400 || url.includes('favicon')) return;

  const path = url.split('?')[0].replace(/^https?:\/\/[^\/]+/, '');
  const method = resp.request().method();
  const authPresent = !!resp.request().headers()['authorization'];
  const ts = new Date().toISOString();
  const isRest = url.includes('/rest/v1/');
  const isAuth = url.includes('/auth/');
  const phase = getPhase();

  const errorEntry = { url: url.split('?')[0], status, ts, method, authPresent, phase };

  if (isRest && !isAuth) {
    const trace = (phase === 'OFFICIAL_PERSONAL' || phase === 'OFFICIAL_BUSINESS') ? OFFICIAL_TRACE : STARTUP_TRACE;
    const entry = [...trace].reverse().find(e => e.path === path && e.httpStatus === null);
    if (entry) { entry.httpStatus = status; entry.responseTs = ts; }
    else trace.push({ ts, method, path, authPresent, profile: currentProfile, phase, httpStatus: status, responseTs: ts });
  }

  if (phase === 'OFFICIAL_PERSONAL' || phase === 'OFFICIAL_BUSINESS') OFFICIAL_HTTP_ERRORS.push(errorEntry);
  else STARTUP_HTTP_ERRORS.push(errorEntry);

  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && isRest && !isAuth) {
    const prefer = resp.request().headers()['prefer'] || '';
    if (!prefer.includes('return=representation')) {
      MUTATIONS.push({ method, url: url.split('?')[0], phase });
    }
  }
}

function recordConsole(msg) {
  if (msg.type() !== 'error') return;
  const text = msg.text().slice(0, 300);
  const phase = getPhase();
  if (phase === 'OFFICIAL_PERSONAL' || phase === 'OFFICIAL_BUSINESS') OFFICIAL_CONSOLE_ERRORS.push(text);
  else STARTUP_CONSOLE_ERRORS.push(text);
}

function setupCloseListeners(page, context, browser) {
  const onUnexpected = (source) => () => {
    const entry = { source, ts: new Date().toISOString(), state, profile: currentProfile };
    CLOSE_EVENTS.push(entry);
    console.log(`[CLOSE_EVENT] ${source} ts=${entry.ts} state=${entry.state} profile=${entry.profile}`);
  };
  page.on('close', onUnexpected('PAGE_CLOSE'));
  context.on('close', onUnexpected('CONTEXT_CLOSE'));
  browser.on('disconnected', onUnexpected('BROWSER_DISCONNECTED'));
}

async function isLoginVisible(page) {
  const emailInput = await page.$('input[type="email"]');
  return !!emailInput;
}

async function isAppShellVisible(page) {
  const hasLogin = await isLoginVisible(page);
  if (hasLogin) return false;
  const bodyText = await safeTextContent(page, 'body');
  return bodyText.length > 100;
}

async function validateHome(page, profileName) {
  await sleep(2000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  const bodyText = await safeTextContent(page, 'body');

  log('perfil', bodyText.toLowerCase().includes(profileName.toLowerCase()),
    `perfil ${profileName} detectado`);

  const forbiddenLabels = ['posted', 'pending', 'review', 'scheduled', 'ignored', 'Confirmada', 'Agendada', 'Ignorada'];
  const foundForbidden = forbiddenLabels.filter(l => new RegExp(`\\b${l}\\b`, 'i').test(bodyText));
  log('no-forbidden-status', foundForbidden.length === 0,
    foundForbidden.length > 0 ? `FOUND: ${foundForbidden.join(', ')}` : 'nenhum status proibido visivel');

  const pagoCount = await page.locator('span.badge-posted').count().catch(() => 0);
  log('pago-badge', pagoCount > 0,
    pagoCount > 0 ? `${pagoCount} badge(s) Pago` : 'Pago NAO encontrado');

  const naoPagoCount = await page.locator('span.badge-pending').count().catch(() => 0);
  log('nao-pago-badge', naoPagoCount > 0,
    naoPagoCount > 0 ? `${naoPagoCount} badge(s) Nao pago` : 'Nao pago NAO encontrado');

  return pagoCount > 0 && naoPagoCount > 0;
}

async function validateCutoffJuly(page) {
  console.log('  Navegando para julho 2026...');
  const prevBtn = page.locator('button[aria-label="Periodo anterior"]').first();
  if (await prevBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await prevBtn.click({ timeout: 5000 });
    await sleep(3000);
    const pagoJulho = await page.locator('span.badge-posted').count().catch(() => 0);
    const naoPagoJulho = await page.locator('span.badge-pending').count().catch(() => 0);
    const totalBadges = pagoJulho + naoPagoJulho;
    log('julho-cutoff', totalBadges === 0,
      totalBadges === 0 ? 'julho: nenhum badge (cutoff ok)' : `julho: ${totalBadges} badge(s) inesperado(s)`);

    const nextBtn = page.locator('button[aria-label="Proximo periodo"]').first();
    if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await nextBtn.click({ timeout: 5000 });
      await sleep(2000);
    }
  } else {
    log('julho-cutoff', null, 'botao periodo anterior nao encontrado');
  }
}

function printStartupReport() {
  console.log('\n=== NETWORK GUARD (STARTUP — informativo) ===');
  if (STARTUP_HTTP_ERRORS.length > 0) {
    console.log(`  ${STARTUP_HTTP_ERRORS.length} HTTP error(s) durante startup:`);
    for (const e of STARTUP_HTTP_ERRORS) {
      console.log(`    ${e.status} ${e.method} ${e.url} auth=${e.authPresent} ts=${e.ts}`);
    }
  } else {
    console.log('  0 HTTP errors durante startup');
  }
  if (STARTUP_CONSOLE_ERRORS.length > 0) {
    console.log(`  ${STARTUP_CONSOLE_ERRORS.length} console error(s) durante startup`);
  }

  console.log('\n=== REQUEST TRACE — STARTUP (informativo) ===');
  for (const r of STARTUP_TRACE) {
    console.log(`  [${r.phase}] ${r.method} ${r.path} auth=${r.authPresent} profile=${r.profile} ts=${r.ts}${r.httpStatus ? ` status=${r.httpStatus}` : ''}`);
  }
  const startup401 = STARTUP_TRACE.filter(r => r.httpStatus === 401);
  if (startup401.length > 0) {
    console.log(`\n  >> ${startup401.length} request(s) STARTUP retornou 401 — classificar: STARTUP_AUTH_RACE / STALE_SESSION_ON_INITIAL_LOAD / INCONCLUSIVE`);
  }
}

function printOfficialReport() {
  console.log('\n=== REQUEST TRACE — OFICIAL ===');
  for (const r of OFFICIAL_TRACE) {
    console.log(`  [${r.phase}] ${r.method} ${r.path} auth=${r.authPresent} profile=${r.profile} ts=${r.ts}${r.httpStatus ? ` status=${r.httpStatus}` : ''}`);
  }
  const official401 = OFFICIAL_TRACE.filter(r => r.httpStatus === 401);
  if (official401.length > 0) {
    console.log(`\n  >> ${official401.length} request(s) OFICIAL retornou 401`);
  } else {
    console.log('\n  >> 0 HTTP 401 na janela oficial');
  }

  console.log('\n=== NETWORK GUARD (OFICIAL) ===');
  const officialMutations = MUTATIONS.filter(m => m.phase.startsWith('OFFICIAL'));
  log('transaction-mutations', officialMutations.length === 0,
    officialMutations.length === 0 ? '0 mutations' : JSON.stringify(officialMutations));

  log('http-errors-oficiais', OFFICIAL_HTTP_ERRORS.length === 0,
    OFFICIAL_HTTP_ERRORS.length === 0 ? '0 HTTP >=400' : JSON.stringify(OFFICIAL_HTTP_ERRORS));

  const official401Errors = OFFICIAL_HTTP_ERRORS.filter(e => e.status === 401);
  log('http-401-oficiais', official401Errors.length === 0,
    official401Errors.length === 0 ? '0 HTTP 401' : JSON.stringify(official401Errors));

  log('console-errors-oficiais', OFFICIAL_CONSOLE_ERRORS.length === 0,
    OFFICIAL_CONSOLE_ERRORS.length === 0 ? '0 errors' : OFFICIAL_CONSOLE_ERRORS.slice(0, 5).join(' | '));
}

function printCloseReport() {
  console.log('\n=== CLOSE EVENTS (lifecycle) ===');
  const unexpected = CLOSE_EVENTS.filter(e => e.state !== 'CLOSING');
  const expectedDuringClose = CLOSE_EVENTS.filter(e => e.state === 'CLOSING' && e.source !== 'SCRIPT_CLOSE');
  if (unexpected.length === 0) {
    console.log('  Nenhum close inesperado');
  } else {
    for (const ce of unexpected) {
      console.log(`  [UNEXPECTED] ${ce.source} ts=${ce.ts} state=${ce.state} profile=${ce.profile}`);
    }
  }
  if (expectedDuringClose.length > 0) {
    console.log(`  ${expectedDuringClose.length} close event(s) durante CLOSING — EXPECTED (causado por browser.close())`);
    for (const ce of expectedDuringClose) {
      console.log(`  [EXPECTED] ${ce.source} ts=${ce.ts} state=${ce.state}`);
    }
  }
  console.log(`  closeReason: ${closeReason}`);
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  setupCloseListeners(page, context, browser);
  page.on('request', recordRequest);
  page.on('response', recordResponse);
  page.on('console', recordConsole);

  await page.goto(PROD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // ─── WAITING_PERSONAL_LOGIN ───
  state = 'WAITING_PERSONAL_LOGIN';
  console.log('\n========================================');
  console.log('  SMOKE PRODUCAO — v3');
  console.log('  Faca login como PESSOAL no browser.');
  console.log('  O browser permanecera aberto.');
  console.log('========================================\n');

  let loggedIn = false;
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const hasLogin = await isLoginVisible(page);
    if (!hasLogin) { loggedIn = true; break; }
    if (i % 6 === 0) console.log(`  aguardando login Pessoal... (${Math.round(i * 5)}s)`);
  }
  if (!loggedIn) {
    closeReason = 'TIMEOUT_PERSONAL_LOGIN';
    console.error('TIMEOUT: login Pessoal nao detectado em 10 min');
    await browser.close().catch(() => {});
    process.exit(1);
  }

  // ─── PERSONAL_STABILIZING ───
  state = 'PERSONAL_STABILIZING';
  console.log('\n>>> Login Pessoal detectado. Aguardando estabilizacao...');
  await sleep(5000);

  state = 'PERSONAL_OFFICIAL_SMOKE';
  console.log('\n>>> === START_OFFICIAL_PERSONAL ===');
  const pagoPessoal = await validateHome(page, 'Pessoal');
  await validateCutoffJuly(page);
  console.log('>>> === END_OFFICIAL_PERSONAL ===');
  personalCompleted = true;

  printStartupReport();
  STARTUP_HTTP_ERRORS.length = 0;
  STARTUP_CONSOLE_ERRORS.length = 0;
  STARTUP_TRACE.length = 0;

  // ─── WAITING_PROFILE_SWITCH ───
  state = 'WAITING_PROFILE_SWITCH';
  console.log('\n========================================');
  console.log('  TROQUE PARA O PERFIL NEGOCIO');
  console.log('  O browser permanecera aberto.');
  console.log('  Faca a troca pelo app.');
  console.log('========================================\n');

  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const hasLogin = await isLoginVisible(page);
    if (hasLogin) {
      console.log(`  tela de login detectada — aguardando autenticacao... (${Math.round(i * 5)}s)`);
      break;
    }
    if (i % 6 === 0) console.log(`  aguardando troca de perfil... (${Math.round(i * 5)}s)`);
  }

  // ─── WAITING_BUSINESS_LOGIN ───
  state = 'WAITING_BUSINESS_LOGIN';
  console.log('\n========================================');
  console.log('  FACa LOGIN NO PERFIL NEGOCIO');
  console.log('  O browser permanecera aberto.');
  console.log('  Aguardando autenticacao...');
  console.log('========================================\n');

  let businessAuth = false;
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const hasLogin = await isLoginVisible(page);
    if (!hasLogin) {
      const appShell = await isAppShellVisible(page);
      if (appShell) {
        businessAuth = true;
        break;
      }
    }
    if (i % 6 === 0) console.log(`  aguardando login Negocio... (${Math.round(i * 5)}s)`);
  }

  if (!businessAuth) {
    closeReason = 'TIMEOUT_BUSINESS_LOGIN';
    console.error('\nTIMEOUT: login Negocio nao concluido em 10 min');
    console.error('BLOCKED: BUSINESS_LOGIN_NOT_COMPLETED');
    printStartupReport();
    printOfficialReport();
    printCloseReport();
    console.log('\n=== RESULTADO FINAL: BLOCKED ===');
    await browser.close().catch(() => {});
    process.exit(1);
  }

  // ─── BUSINESS_STABILIZING ───
  state = 'BUSINESS_STABILIZING';
  currentProfile = 'Negócio';
  console.log('\n>>> Login Negocio detectado. Aguardando estabilizacao...');
  await sleep(5000);

  // ─── BUSINESS_OFFICIAL_SMOKE ───
  state = 'BUSINESS_OFFICIAL_SMOKE';
  console.log('\n>>> === START_OFFICIAL_BUSINESS ===');
  const pagoNegocio = await validateHome(page, 'Negócio');
  await validateCutoffJuly(page);
  console.log('>>> === END_OFFICIAL_BUSINESS ===');
  businessCompleted = true;

  // ─── REPORTING ───
  state = 'REPORTING';
  printOfficialReport();

  const officialMutations = MUTATIONS.filter(m => m.phase.startsWith('OFFICIAL'));
  const has401 = OFFICIAL_HTTP_ERRORS.some(e => e.status === 401);
  const has4xx = OFFICIAL_HTTP_ERRORS.length > 0;
  const hasConsoleErr = OFFICIAL_CONSOLE_ERRORS.length > 0;
  const hasMutations = officialMutations.length > 0;

  const allPassed = personalCompleted && businessCompleted
    && pagoPessoal && !has401 && !has4xx && !hasConsoleErr && !hasMutations;

  console.log(`\n=== RESULTADO FINAL: ${allPassed ? 'PASS' : 'FAIL'} ===`);
  if (!allPassed) {
    if (!pagoPessoal) console.log('  MOTIVO: Pessoal Pago nao encontrado');
    if (has401) console.log('  MOTIVO: HTTP 401 na janela oficial');
    if (has4xx) console.log('  MOTIVO: HTTP >=400 na janela oficial');
    if (hasConsoleErr) console.log('  MOTIVO: console errors na janela oficial');
    if (hasMutations) console.log('  MOTIVO: transaction mutations detectadas');
  }

  // ─── CLOSING ───
  state = 'CLOSING';
  closeReason = 'NORMAL_SCRIPT_SHUTDOWN';
  CLOSE_EVENTS.push({ source: 'SCRIPT_CLOSE', ts: new Date().toISOString(), state, profile: currentProfile });
  await browser.close().catch(() => {});
  printCloseReport();
  console.log('Smoke concluido.');
}

main().catch((e) => {
  console.error('ERRO FATAL:', e.message);
  process.exit(1);
});

# MANIFEST — Pacote Cloud 016: Account Profile Periods por Perfil (ACC-P0)

Status: **APLICADA, VERIFICADA E REGISTRADA** — migration 016 aplicada no Cloud (exit 0), VERIFY_POST aprovado, registrada em `schema_migrations` e smoke de produção pós-016 aprovado.
Baseline pré-016 vigente à aplicação: Cloud 013 + hotfix 013b aplicados; **014 APLICADA e vigente** (checkpoint pré-016 aprovado com 37/37 asserts).

## 1. Objetivo
Permitir que a **mesma conta** tenha períodos simultâneos em **perfis diferentes**, mantendo a proibição de sobreposição **dentro do mesmo perfil**, e reconstruir deterministicamente associações `account_id + profile_id` ausentes a partir das transações existentes — **sem alterar nenhuma transação**.

## 2. Problema comprovado
- `accounts` não possui `profile_id`; a associação conta↔perfil é `account_profile_periods`.
- O trigger `public.app_check_no_overlap_periods()` (pré-016) detectava overlap **apenas por `account_id`** (ignorava `profile_id`) → a mesma conta não podia ter períodos em dois perfis, mesmo em datas distintas.
- Auditoria local (ACC-P0) mostrou no seed: 44 pares usados, 27 pares **sem associação**, 2.580 transações sem período válido — a associação ausente precisava de backfill determinístico.

## 3. Regra aprovada
- Sobreposição **proibida** = mesmo `account_id` + mesmo `profile_id`.
- Sobreposição **permitida** = perfis diferentes, mesmas datas.

## 4. Arquivos do pacote (SHA-256)
| Arquivo | Tipo | SHA-256 |
|---|---|---|
| `supabase/migrations/016_account_profile_periods_by_profile.sql` | Migration local (ACC-P0 aprovado) | `569A0FD9850F65133830BA1C18C5A82E9D477BC04740090070781E39F52901A7` |
| `supabase/cloud/016_cloud_account_profile_periods_by_profile.sql` | Migration Cloud (atômica) | `628A1F068ECAF20446FA2050DF0C0C40A692F9E2A6483B9497AC668A424605FD` |
| `supabase/cloud/PREFLIGHT_CLOUD_016_ACCOUNT_PERIODS_READONLY.sql` | Pré-validação (12 stages, read-only) | `212E535274354BF052FDADF3E8243728F8CC39F2B4C9F663CA9EA58D4390C8D4` |
| `supabase/cloud/VERIFY_POST_CLOUD_016_ACCOUNT_PERIODS_READONLY.sql` | Pós-validação (8 stages, read-only) | `441DA4B56574556AF437F72BD9145E5BFAC50470DB44135FB336B44F2D75F32B` |
| `supabase/cloud/ROLLBACK_CLOUD_016_ACCOUNT_PERIODS.sql` | Rollback (estrutural + dados determinísticos) | `BB1E5E4B0BD17D7CDC2CC8A6E417FCE51CB2937D77AF4A8C0666987C87F9FDEB` |

## 5. Efeitos da migration (Cloud 016)
1. **Trigger**: `public.app_check_no_overlap_periods()` passa a considerar `account_id` **e** `profile_id` na detecção de overlap (mesmo `daterange`, `ends_on NULL = aberto`, INSERT/UPDATE preservados).
2. **Backfill determinístico e idempotente** (`NOT EXISTS`): para cada par `(account_id, profile_id)` com transações físicas (inclui soft-deleted) e sem associação, insere **1 período**: `starts_on = MIN(occurred_on)`, `ends_on = NULL`, `source = 'backfill_016'`, **id determinístico** `md5(account_id::text || ':' || profile_id::text)::uuid` (md5 nativo; sem extensão).
3. Não altera `transactions`, `category_id`, `category_raw`, nem períodos existentes; não infere `ends_on`; não usa nomes de contas.

## 6. Pré-condições (PREFLIGHT — exigências)
- Estrutura presente (tabela, colunas, base, função, trigger, `assert_account_for_profile`).
- Função atual no estado **pré-016** (overlap por `account_id`, sem `profile_id`).
- **BLOCKED** se: pares com período mas transações fora de todos os períodos (backfill não corrige); overlaps existentes no mesmo perfil; 016 já registrado em `schema_migrations`.
- Contagens derivadas do estado no momento (nada hardcodado).

## 7. Execução (CONCLUÍDA — histórico autorizado)
1. Backup/checkpoint pré-016: aprovado (dump + manifest + restauração/validação 37/37 PASS).
2. `PREFLIGHT_CLOUD_016_ACCOUNT_PERIODS_READONLY.sql` → **APROVADO: 10 PASS, 2 INFO, 0 BLOCKED**. Baseline imediatamente pré-016: períodos = 19, pares_sem_assoc = 27, uncovered = 2580, overlaps_mesmo_perfil = 0.
3. `016_cloud_account_profile_periods_by_profile.sql` → **aplicação psql exit 0; backfill INSERT 0 27; COMMIT concluído**.
4. `VERIFY_POST_CLOUD_016_ACCOUNT_PERIODS_READONLY.sql` → **7 PASS, 1 INFO, 0 BLOCKED**. Pós: períodos = 46 (19 + 27 backfill), pares_sem_assoc = 0, uncovered = 0, overlaps = 0.
5. Fingerprints preservados: tx_hash = `c76d157c1c142c98019721864c6734ed`; cat_id_hash = `c24bc5b51cd9e4ccb9da26292138ece4`; cat_raw_hash = `90af358a46bef23defea2bce024e760a`; n_tx_fisico = 11873; n_tx_ativo = 11869.
6. Registro em `schema_migrations` **EXECUTADO e conferido** (1 linha; version e checksum corretos; applied_at presente).
7. Smoke produção pós-016 → **APROVADO: 45 checagens, 0 falhas** (contas Pessoal 20/20 e Negócio 26/26, missing=0, extra=0; categorias renderizáveis 75/75 e 52/52; troca Pessoal→Negócio→Pessoal PASS; shared=2 permitidas; vazamento exclusivo=0; console errors=0; Supabase ≥400=0; zero escrita=PASS).

## 8. Registro em schema_migrations (EXECUTADO e conferido)
```sql
INSERT INTO schema_migrations (version, checksum, applied_at)
VALUES (
  '016_cloud_account_profile_periods_by_profile.sql',
  '628A1F068ECAF20446FA2050DF0C0C40A692F9E2A6483B9497AC668A424605FD',
  now()
)
ON CONFLICT (version) DO NOTHING;
```
Conferido read-only: 1 linha com version, checksum `628A1F06...` e `applied_at` presente.

## 9. Rollback (comportamento)
- **Estrutural**: restaura a função ANTERIOR (overlap por `account_id`, sem `profile_id`).
- **Dados**: remove **exatamente** as linhas do backfill (identificação determinística: `source='backfill_016'` **e** `id = md5(account_id::text||':'||profile_id::text)::uuid`). Períodos legítimos criados depois (outros ids/sources) **não** são apagados. Sem DELETE por aproximação; sem CASCADE; sem desabilitar trigger.
- Efeito colateral documentado: pós-rollback, a mesma conta volta a não poder ter períodos em dois perfis (comportamento anterior).

## 10. Invariantes (pós-016)
- Pares usados sem associação = 0.
- Transações sem período válido = 0 (mesma regra de cobertura do `assert_account_for_profile`).
- Overlaps dentro de `(account_id, profile_id)` = 0.
- `transactions`, `category_id`, `category_raw` e períodos existentes inalterados (fingerprints no PREFLIGHT/VERIFY_POST para comparação humana).

## 11. Resultados dos testes locais (PGLite descartável)
- **ACC-P0 (migration local)**: 24/24 PASS (trigger 4, backfill 3, idempotência, conta compartilhada 4, global+integridade 7, setup).
- **Cloud-like 016** (pacote Cloud real aplicado sobre estado 013): preflight obrigatórios PASS, verify pós 8/8 PASS, comportamentos cobertos (overlap rejeitado/permitido, backfill, idempotência, cobertura, preservação, soft-deleted, rollback testado).
- Frontend: Vitest 302/302; tsc 0; build 0; `git diff --check` 0.

## 12. Segurança
Nenhum segredo/token/senha neste diretório. Estado atual: 016 **aplicada** (exit 0), **verificada** (VERIFY_POST 7 PASS / 1 INFO / 0 BLOCKED) e **registrada** em `schema_migrations`.

## 13. Finding separado — FORA DO ESCOPO da 016 (não corrigido)
`categories_hierarchy_integrity` (diagnóstico read-only do smoke):
- Pessoal: direct_cross_direction = 3, descendants_affected = 0.
- Negócio: direct_cross_direction = 16, descendants_affected = 10.
- Total afetado = 29.

Finding de **qualidade/hierarquia de dados** de categorias (vinculos `parent_id` cruzando `direction`, tornando nós não renderizáveis na árvore por direção da UI). **Não é corrigido pela CLOUD 016**, não invalida ACC-P0 e **requer decisão separada**.
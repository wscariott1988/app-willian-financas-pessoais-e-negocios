# MANIFEST — Pacote Cloud 014: Visibilidade da Auditoria (denormalização profile_id)

Status: PRONTO PARA REVISÃO (nada aplicado).
Pré-requisito: Cloud 013 aplicado e verificado (9/9) + hotfix de grants 013b aplicado.

## ⚠️ AVISO

- A migration `013_cloud_transaction_delete.sql` **já foi aplicada** e **NÃO deve ser reaplicada nem modificada** (hash `4DF87F2D73A3E2CD93CE64418A20AA0634330ED15DE4BE0C2F3E2FF8CE2DB6AD` registrado no Cloud).
- A recorrência/parcelamento antes planejada como 014 passa a ser **migration 015** (não faz parte deste pacote).

## 1. Escopo

Corrige a **visibilidade** da auditoria no "Histórico de alterações" por **denormalização de `profile_id`** nas tabelas `transaction_audit` e `category_assignment_audit`.

| Capacidade | Detalhe |
|---|---|
| Problema | `ta_select_own`/`audit_select_own` resolviam o perfil por subquery em `transactions`; com `transactions_select_own` exigindo `deleted_at IS NULL` (013), auditorias de transações soft-deletadas ficavam ocultas ao dono |
| Solução | `profile_id` denormalizado + trigger `SECURITY DEFINER` que deriva o perfil exclusivamente da transação (funciona p/ soft-deleted) |
| Policies | `ta_select_own` e `audit_select_own` passam a usar `profile_id = app.jwt_profile_id()` diretamente (sem subquery) |
| Escrita | policies `ta_write_service`/`audit_write_service` (service_role) e grants preservados |
| Auditorias antigas | preservadas integralmente; backfill determinístico + asserts (zero NULL / zero divergência) antes de NOT NULL |
| Trigger (hardened) | `SET search_path = pg_catalog, public, app, pg_temp`; referências 100% qualificadas; `REVOKE EXECUTE` de PUBLIC, anon e authenticated; ignora/sobrescreve `profile_id` fornecido pelo cliente |
| Passo 8 | **Restaura auditoria de UPDATE** — regressão do 013: `app.transaction_update` do 013 removeu o INSERT de auditoria que o 012 tinha; corpo = exatamente o do 013 + INSERT em `transaction_audit` (1 por edição; conflito/falha = 0) |
| Frontend | paginação **cumulativa** (10/20/30... por fonte, sem cursor `lt`), ordenação estável `created_at DESC → source → id`, zero perda/duplicação com timestamps idênticos |

## 2. Arquivos

| Arquivo | Tipo | SHA-256 |
|---|---|---|
| `PREFLIGHT_CLOUD_014_AUDIT_READONLY.sql` | Pré-validação (10 checks, read-only) | `FE7A85FA4A370E2CD3F6E88A651CA756292500AC2630B6BAE96D0174A5E2EC11` |
| `014_cloud_audit_profile_visibility.sql` | Migração (atômica, hardened, 8 passos) | `C6717472F6DB2AFADE1942AF68C2C03C35223227FA379A670997042A426A96EE` |
| `VERIFY_POST_CLOUD_014_AUDIT_READONLY.sql` | Pós-validação (14 checks, read-only) | `59E67DF665C1D6A4DEB1E17214737B809010AD206FAAAF3A9A1B373AA994CD5F` |
| `ROLLBACK_CLOUD_014_AUDIT.sql` | Rollback (reverte estrutura; restaura policies antigas) | `A4131C055CAFC8C017DE7254BF4C7707F67D9678C9646C52800D68A81754BB2F` |
| Local: `supabase/migrations/014_audit_profile_visibility.sql` | Migração local (espelho) | `F1B5901146F29F6C5502B4996F907A426D6C1171C40953AAB0FD85785F5260D1` |

> Frontend (commit separado, não faz parte do pacote SQL):
> `mvp-app/src/lib/auditFeed.ts` (`205B638D5A153B3B1E8C50EFF0F7770ACB944109987F10F7D39B63577900BEA9`),
> `mvp-app/src/components/AuditLogs.tsx` (`27EE2D19445F5EE4D20271D84BDCD1F167D026C8AD5B3023CD6F415260F0D3F7`),
> `mvp-app/src/tests/auditFeed.test.ts` (`D514507D39E74DF367D1595550383E274C0C84EA0206CAEED51A2C3A47A000C2`).

## 3. Ordem de execução (SQL Editor, arquivo por arquivo)

1. `PREFLIGHT_CLOUD_014_AUDIT_READONLY.sql`
   - Etapas 1-3, 6, 7: `PASS`
   - Etapas 4, 5: `PASS` (profile_id ainda não existe → 014 não aplicado)
   - Etapas 8, 9: `PASS` ou `SEM_CASO` (contexto)
   - Etapa 10: `PASS` (anon/authenticated sem CREATE em public/app)
2. `014_cloud_audit_profile_visibility.sql` → aplicação atômica (BEGIN/COMMIT; RAISE aborta e desfaz)
3. Registrar 014 em `schema_migrations` (statement separada, abaixo)
4. `VERIFY_POST_CLOUD_014_AUDIT_READONLY.sql` → todas as 14 etapas `PASS`
5. (Separado) Frontend `AuditLogs.tsx` + testes + deploy

## 4. Registro em schema_migrations

Executar IMEDIATAMENTE após a aplicação do 014:

```sql
INSERT INTO schema_migrations (version, checksum, applied_at)
VALUES ('014_cloud_audit_profile_visibility.sql', 'C6717472F6DB2AFADE1942AF68C2C03C35223227FA379A670997042A426A96EE', now())
ON CONFLICT (version) DO NOTHING;
```

## 5. Procedimento de parada

- Se PREFLIGHT der BLOCKED (1-3, 6, 10): **NÃO aplicar** o 014; investigar pré-requisito.
- Se VERIFY_POST der BLOCKED após aplicação: aplicar `ROLLBACK_CLOUD_014_AUDIT.sql` e investigar.
- Rollback **não** restaura a denormalização (limitação conhecida: auditoria de soft-delete volta a ficar oculta ao dono), mas não perde dados.

## 6. Isolamento garantido (pós-014)

- Pessoal vê somente auditorias com `profile_id` do perfil Pessoal.
- Negócio vê somente auditorias do perfil Negócio.
- Auditoria de transação excluída (soft-delete) permanece visível ao **proprietário** (policy direta por `profile_id`, sem dependência de `transactions`).
- Outro perfil não tem acesso (RLS por `profile_id`); `profile_id` fornecido pelo cliente é sempre sobrescrito pelo trigger.

## 7. Notas de implantação

- **Idempotência**: `ADD COLUMN IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE POLICY`, `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`, índices `IF NOT EXISTS`.
- **Reversibilidade parcial**: rollback remove colunas/triggers/FKs e restaura as policies antigas (subquery). Dados de auditoria intactos.
- **PGLite local**: cenários testados em banco descartável Cloud-like (35/35): backfill, ciclo create/update/delete/categoria, exatamente 1 auditoria por update (0 em conflito), delete visível pós soft-delete, isolamento cruzado, spoofing de `profile_id` ignorado, timestamps idênticos sem perda/duplicação na paginação cumulativa, rollback preservando dados.

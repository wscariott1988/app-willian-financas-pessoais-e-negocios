# MANIFEST — Hotfix 013b: Grants transaction_delete

Status: PRONTO PARA REVISÃO (nada aplicado no Cloud).
Pré-requisito: Cloud 013 já aplicado e registrado em `schema_migrations`.

## ⚠️ AVISO IMPORTANTE

A migration `013_cloud_transaction_delete.sql` **já foi aplicada ao Cloud**.
Este hotfix **NÃO deve ser reaplicado nem substituir** a migration 013 original.
Ele corrige apenas as GRANTs das funções `transaction_delete` já existentes.

## 1. Escopo

Corrige ACLs das funções `transaction_delete` criadas pelo Cloud 013.

| Capacidade | Detalhe |
|---|---|
| Problema | `anon` herdou `EXECUTE` via PUBLIC em `app.transaction_delete` e `public.transaction_delete` |
| Causa raiz | 013 executou `GRANT TO authenticated` sem `REVOKE FROM PUBLIC` antes |
| Correção | `REVOKE FROM PUBLIC` + `REGRANT TO authenticated` (idempotente) |
| Rollback | Desativa a delete (revoga de todos os roles); **NUNCA** restaura acesso anônimo |
| 5 statements | 2 REVOKE FROM PUBLIC + 2 GRANT TO authenticated + 1 NOTIFY |

## 2. Arquivos

| Arquivo | Tipo | SHA-256 |
|---|---|---|
| `PREFLIGHT_HOTFIX_013_GRANTS_READONLY.sql` | Pré-validação (3 checks, read-only) | `EA92733988230ABB8BE9AEDEA4EB8E2DF1A5BAAC5BD4CE50801B7042CE6D8C9B` |
| `HOTFIX_013_GRANTS_REVOKE_ANON.sql` | Fix (5 statements) | `45B72502E0652B7AC96949F199B716F8CB98A3A2AD9BFEC6AC35606C3079906A` |
| `VERIFY_POST_HOTFIX_013_GRANTS_READONLY.sql` | Pós-validação (4 checks, read-only) | `17DE30560B90F15B951BDCAC9F8A1C1DD4F5FADD1469AB67C86EE6EFF984F058` |
| `ROLLBACK_HOTFIX_013_GRANTS.sql` | Rollback (desativa delete total) | `DC695BE78A2A3105EA7B10617F6AB328D97881693AEED771383AF4E8AE0E65AB` |

## 3. Ordem de execução (SQL Editor, arquivo por arquivo)

1. `PREFLIGHT_HOTFIX_013_GRANTS_READONLY.sql`
   - Etapas 1-2: `BUG_CONFIRMED` (anon tem EXECUTE — confirma que o fix é necessário)
   - Etapa 3: `PASS` (authenticated já tem EXECUTE)
2. `HOTFIX_013_GRANTS_REVOKE_ANON.sql`
   - 5 statements: 2 REVOKE FROM PUBLIC + 2 GRANT TO authenticated + 1 NOTIFY
3. `VERIFY_POST_HOTFIX_013_GRANTS_READONLY.sql`
   - 4 checks: todas devem dar `PASS`
4. `VERIFY_POST_CLOUD_013_READONLY.sql` (verificação existente)
   - `stg_013_grants` deve dar `PASS` (antes era `BLOCKED`)
   - Demais etapas permanecem `PASS`

## 4. Estados esperados por etapa

| Etapa | Arquivo | Status esperado | Se BLOCKED |
|---|---|---|---|
| 1 | PREFLIGHT | 1-2 BUG_CONFIRMED, 3 PASS | Parar — verificar se 013 foi aplicado |
| 2 | HOTFIX | Executa sem erro | Parar — verificar sintaxe |
| 3 | VERIFY POST | Todas PASS | Aplicar ROLLBACK; investigar |
| 4 | VERIFY 013 | stg_013_grants PASS | stg_013_grants BLOCKED = hotfix não funcionou |

## 5. Registro em schema_migrations

Executar IMEDIATAMENTE após o HOTFIX:

```sql
INSERT INTO schema_migrations (version, checksum, applied_at)
VALUES ('HOTFIX_013_GRANTS_REVOKE_ANON.sql', '45B72502E0652B7AC96949F199B716F8CB98A3A2AD9BFEC6AC35606C3079906A', now())
ON CONFLICT (version) DO NOTHING;
```

## 6. Rollback

`ROLLBACK_HOTFIX_013_GRANTS.sql` — desativa a delete em TODOS os roles.

- Revoga EXECUTE de `app.transaction_delete` e `public.transaction_delete` de `PUBLIC`, `anon` e `authenticated`
- Recarrega schema PostgREST
- **NUNCA** restaura acesso anônimo
- **NÃO remove** colunas `deleted_at`, não apaga auditorias
- Reativação: dois GRANTs TO authenticated + reload (instruções no rodapé do arquivo)

## 7. Notas

- **Idempotência**: REVOKE de privilegio inexistente é noop no PostgreSQL
- **Segurança**: se a verificação pós-hotfix falhar, o rollback desabilita a delete em vez de restaurar acesso anônimo
- **PGLite local**: todos os cenários testados em banco descartável pós-013
- **Não modifica schema_migrations da migration 013 original**

# MANIFEST — Pacote Cloud 013 (aplicação manual no SQL Editor)

Status: PRONTO PARA REVISÃO (nada aplicado).
Pré-requisito: Cloud 009–012 já aplicados e verificados (VERIFY_POST_CLOUD_009_012 todos PASS).

## 1. Escopo

Migração `013_cloud_transaction_delete.sql` — exclusão segura via soft-delete.

| Capacidade | Detalhe |
|---|---|
| Soft-delete | `deleted_at timestamptz` em `transactions` e `transfer_links`; `deleted_at IS NULL` na RLS SELECT |
| Isolamento | `profile_id = app.jwt_profile_id()` em todas as funções (não depende do cliente) |
| expected_updated_at | Obrigatório em `transaction_delete`; comparação com tolerância 0.001s |
| Transferência | Exclui atomicamente ambas pontas + link; fecha filas abertas de ambas |
| Auditoria | `transaction_audit` com action `'delete'`; `category_assignment_audit` preservada |
| category_raw | Imutável — nenhuma função altera o campo |
| Guards | `transaction_update`, `assign_category_atomic`, `transaction_get_detail` rejeitam transações excluídas |
| Wrappers | `public.transaction_delete(uuid, timestamptz)` SECURITY INVOKER; `app.transaction_delete` SECURITY DEFINER |
| Grants | `authenticated` em `app.transaction_delete` e `public.transaction_delete`; `anon` sem nada |

## 2. Arquivos

| Arquivo | Tipo | SHA-256 |
|---|---|---|
| `PREFLIGHT_CLOUD_013_READONLY.sql` | Pré-validação (read-only) | `568755440D6DEC4DB9740D98D7F63D5B81EEF9466F7559CA12B42F2AA06A38CD` |
| `013_cloud_transaction_delete.sql` | Migração (DDL + DML) | `4DF87F2D73A3E2CD93CE64418A20AA0634330ED15DE4BE0C2F3E2FF8CE2DB6AD` |
| `VERIFY_POST_CLOUD_013_READONLY.sql` | Pós-validação (read-only) | `67E55D581675CC89EC8A4B47EF79A416C3881EE6FE567D081ABB56788F2DC89E` |
| `ROLLBACK_CLOUD_013_CRUD_DISABLE.sql` | Rollback (grants apenas) | `117A8CEFAF3B81415AB5A9E0F7647C2BA004EEEE1BDCED9747E8610252F4912B` |

## 3. Ordem de execução (SQL Editor, arquivo por arquivo)

1. `PREFLIGHT_CLOUD_013_READONLY.sql` → todas as 7 etapas devem dar PASS.
2. `013_cloud_transaction_delete.sql` → aplicação completa.
3. Registrar 013 em `schema_migrations` (statement separada, abaixo).
4. `VERIFY_POST_CLOUD_013_READONLY.sql` → todas as 9 etapas devem dar PASS.

## 4. Registro em schema_migrations

Executar IMEDIATAMENTE após a aplicação de `013_cloud_transaction_delete.sql`:

```sql
INSERT INTO schema_migrations (version, checksum, applied_at)
VALUES ('013_cloud_transaction_delete.sql', '4DF87F2D73A3E2CD93CE64418A20AA0634330ED15DE4BE0C2F3E2FF8CE2DB6AD', now())
ON CONFLICT (version) DO NOTHING;
```

## 5. Procedimento de parada

Se o PREFLIGHT der BLOCKED em qualquer etapa:
- **NÃO aplicar** o `013_cloud_transaction_delete.sql`.
- Investigar a etapa BLOCKED.
- Corrigir o pré-requisito e reaplicar o PREFLIGHT.

Se o VERIFY_POST der BLOCKED após aplicação:
- Aplicar `ROLLBACK_CLOUD_013_CRUD_DISABLE.sql` (revoga EXECUTE da delete).
- Investigar a etapa BLOCKED.
- Corrigir e reaplicar o 013 (CREATE OR REPLACE é idempotente para funções; ADD COLUMN IF NOT EXISTS é idempotente).

## 6. Rollback

`ROLLBACK_CLOUD_013_CRUD_DISABLE.sql` — desativa APENAS a RPC de exclusão.

- Revoga EXECUTE de `public.transaction_delete` e `app.transaction_delete` para `authenticated`.
- Recarrega schema PostgREST.
- **NÃO remove** colunas `deleted_at`, não apaga auditorias, não restaura policy antiga.
- Reativação: dois GRANTs + reload (instruções no rodapé do arquivo).

## 7. Backup

**Obrigatório**: snapshot do banco ANTES de aplicar o 013.
O soft-delete preserva dados, mas a política RLS muda o comportamento de SELECT.
Uma cópia garantiza reversão completa se necessário.

## 8. Notas de implantação

- **Idempotência**: `CREATE OR REPLACE` para funções; `ADD COLUMN IF NOT EXISTS` para colunas; `DROP POLICY IF EXISTS` + `CREATE POLICY` para RLS. Reaplicação não duplica.
- **Reversibilidade parcial**: o rollback desativa a delete mas mantém a infraestrutura (colunas, policies, guards). Para reversão total, seria necessário DROP das colunas (não recomendado — dados preservados).
- **PGLite local**: todos os cenários foram testados em PGLite descartável simulando o estado Cloud 012.

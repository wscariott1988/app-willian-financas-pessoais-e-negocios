# MANIFEST — Pacote Cloud 009–012 (aplicação manual no SQL Editor)

Status: PRONTO PARA REVISÃO (nada aplicado).
Projeto Cloud: https://aheq***ntxq.supabase.co (ref mascarado) · PostgreSQL 17.6.

## 1. Mapeamento local × Cloud

| Arquivo Cloud | Origem | Tipo |
|---|---|---|
| `009_cloud_categories_profile_isolation.sql` | migration local `008_categories_profile_isolation.sql` (adaptada: asserts de estado vivo) | Estrutural (policy RLS) |
| `010_cloud_marketing_ads_inter_pj.sql` | migration local `009_marketing_ads_inter_pj.sql` (reasons de auditoria renomeados p/ `cloud_010:*`) | Correção de dados (dataset real do Cloud) |
| `011_cloud_manual_receitas_o_montador.sql` | migration local `010_manual_receitas_o_montador.sql` (reasons p/ `cloud_011:*`) | Correção de dados (dataset real do Cloud) |
| `012_cloud_transaction_crud.sql` | migration local `011_transaction_crud_atomic.sql` (**adaptada**: wrappers `public.*` snake_case + revogação de grants diretos + reload PostgREST) | Estrutural + RPCs |

As migrations locais `008–011` NÃO foram movidas nem renumeradas.

## 2. Dataset

As correções 010/011 Cloud são específicas do dataset real presente no Cloud
(comprovado pelo verificador vivo: 3 IDs Inter PJ, 100 IDs O Montador com soma
326876.52 e 64/19/17, 19 filas RP-MAL-01 open, Ads com 39 transações).
NÃO são migrations estruturais genéricas e NÃO dependem de seed sintético.
Não aplicar em outro ambiente sem revalidar as pré-condições (PREFLIGHT).

## 3. Estratégia de registro em schema_migrations (Cloud 009–012)

- A tabela `schema_migrations` do Cloud está VAZIA (confirmado vivo, seção 02).
- NÃO registrar retroativamente 001–008: o histórico vazio não deve ser
  preenchido como se as migrations antigas tivessem sido aplicadas pelo migrador.
- Registrar SOMENTE 009–012, com checksum = SHA-256 do conteúdo do próprio
  arquivo `.sql` aplicado (hash estável, calculado localmente — sem dependência
  circular: o INSERT de registro NÃO fica embutido no arquivo).
- O registro é uma statement separada, executada no SQL Editor IMEDIATAMENTE
  após a aplicação de cada arquivo (idempotente via ON CONFLICT DO NOTHING):

```sql
INSERT INTO schema_migrations (version, checksum, applied_at)
VALUES ('009_cloud_categories_profile_isolation.sql', 'D2FFEE9DDF66BD8E68A8AF23396CDEA764BB0F33350F2A400026FD04AB8D79FA', now())
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version, checksum, applied_at)
VALUES ('010_cloud_marketing_ads_inter_pj.sql', '7D79CB67D0F79DA670B8CDC1651328FE29FC54C026ABF09DDE95D91E2FCA737F', now())
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version, checksum, applied_at)
VALUES ('011_cloud_manual_receitas_o_montador.sql', 'C052FCDB7F2F5394920C78A7AA471E4CABE0216793278D76151C9C776ACBDF08', now())
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version, checksum, applied_at)
VALUES ('012_cloud_transaction_crud.sql', '1CDAED458944D526A20DA4640340A98541A55FF16C270D4BB13006513A9ED315', now())
ON CONFLICT (version) DO NOTHING;
```

- Checksums = SHA-256 dos 4 arquivos .sql entregues nesta rodada (hashes
  verificados antes de cada publicação; recalcular se o arquivo mudar).

## 4. Ordem de execução (SQL Editor, arquivo por arquivo)

1. `PREFLIGHT_CLOUD_009_012_READONLY.sql` → todas as etapas devem dar PASS.
2. `009_cloud_categories_profile_isolation.sql` → registrar 009.
3. `010_cloud_marketing_ads_inter_pj.sql` → registrar 010.
4. `011_cloud_manual_receitas_o_montador.sql` → registrar 011.
5. `012_cloud_transaction_crud.sql` → registrar 012.
6. `VERIFY_POST_CLOUD_009_012_READONLY.sql` → todas as etapas devem dar PASS.

Reaplicação de qualquer arquivo FALHA ruidosamente (asserts de pré-estado) —
nunca duplica silenciosamente.

## 5. Rollback

`ROLLBACK_CLOUD_012_CRUD_DISABLE.sql` — desativa APENAS o CRUD (revoga EXECUTE
dos wrappers `public.*`). Preserva `categories_select_own`, transações,
auditorias e `transaction_audit`. NÃO desfaz 010/011. NUNCA recria
`categories_select_auth` (a policy ampla é permanente e irreversível por decisão).

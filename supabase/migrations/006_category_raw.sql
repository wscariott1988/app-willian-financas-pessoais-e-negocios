-- 006_category_raw.sql - Fase 4B
-- Exposição do texto original de categoria para auditoria/UI (o schema v1.1
-- mapeia categoria por category_id; category_raw preserva o rótulo da fonte).

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_raw text;

CREATE INDEX IF NOT EXISTS idx_tx_category_raw ON transactions (category_raw);

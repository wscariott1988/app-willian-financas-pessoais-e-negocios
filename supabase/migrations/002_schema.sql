-- 002_schema.sql - Fase 4B
-- Schema canônico v1.1 (documento mestre) + extensões aprovadas na Fase 4B
-- (reclassification_queue, category_assignment_audit, auth_users, status scheduled).

-- ---------- profiles ----------
CREATE TABLE profiles (
    id           uuid PRIMARY KEY,
    code         text NOT NULL UNIQUE CHECK (code IN ('personal', 'business')),
    display_name text NOT NULL,
    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------- accounts ----------
CREATE TABLE accounts (
    id              uuid PRIMARY KEY,
    source_name     text NOT NULL,
    display_name    text NOT NULL,
    normalized_name text NOT NULL UNIQUE,
    account_type    text NOT NULL CHECK (account_type IN ('bank', 'credit_card', 'cash', 'benefit', 'investment', 'other')),
    is_active       boolean NOT NULL DEFAULT true,
    archived_at     timestamptz,
    is_favorite     boolean NOT NULL DEFAULT false,
    usage_score     numeric(6, 3) NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- account_profile_periods ----------
CREATE TABLE account_profile_periods (
    id         uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts (id),
    profile_id uuid NOT NULL REFERENCES profiles (id),
    starts_on  date NOT NULL,
    ends_on    date CHECK (ends_on IS NULL OR ends_on >= starts_on),
    source     text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, profile_id, starts_on)
);

-- ---------- categories (árvore recursiva) ----------
CREATE TABLE categories (
    id              uuid PRIMARY KEY,
    profile_id      uuid NOT NULL REFERENCES profiles (id),
    direction       text NOT NULL CHECK (direction IN ('income', 'expense', 'transfer')),
    parent_id       uuid REFERENCES categories (id),
    source_name     text NOT NULL,
    display_name    text NOT NULL,
    normalized_name text NOT NULL,
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'review')),
    canonical_path  text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (profile_id, direction, parent_id, normalized_name)
);

-- ---------- aliases ----------
CREATE TABLE category_aliases (
    id                uuid PRIMARY KEY,
    profile_id        uuid REFERENCES profiles (id),
    direction         text CHECK (direction IN ('income', 'expense', 'transfer')),
    raw_pattern       text NOT NULL,
    normalized_pattern text NOT NULL,
    match_kind        text NOT NULL CHECK (match_kind IN ('exact', 'regex')),
    target_id         uuid NOT NULL REFERENCES categories (id),
    priority          integer NOT NULL DEFAULT 100,
    is_active         boolean NOT NULL DEFAULT true,
    requires_review   boolean NOT NULL DEFAULT false,
    source_evidence   text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (profile_id, normalized_pattern, target_id)
);

CREATE TABLE account_aliases (
    id                uuid PRIMARY KEY,
    profile_id        uuid REFERENCES profiles (id),
    direction         text CHECK (direction IN ('income', 'expense', 'transfer')),
    raw_pattern       text NOT NULL,
    normalized_pattern text NOT NULL,
    match_kind        text NOT NULL CHECK (match_kind IN ('exact', 'regex')),
    target_id         uuid NOT NULL REFERENCES accounts (id),
    priority          integer NOT NULL DEFAULT 100,
    is_active         boolean NOT NULL DEFAULT true,
    requires_review   boolean NOT NULL DEFAULT false,
    source_evidence   text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (profile_id, normalized_pattern, target_id)
);

-- ---------- import_batches ----------
CREATE TABLE import_batches (
    id          uuid PRIMARY KEY,
    source_name text NOT NULL,
    checksum    text,
    status      text NOT NULL DEFAULT 'completed',
    counts      jsonb,
    imported_at timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- transactions ----------
CREATE TABLE transactions (
    id                     uuid PRIMARY KEY,
    profile_id             uuid NOT NULL REFERENCES profiles (id),
    account_id             uuid NOT NULL REFERENCES accounts (id),
    category_id            uuid REFERENCES categories (id),
    transaction_kind       text NOT NULL CHECK (transaction_kind IN ('income', 'expense', 'transfer')),
    amount                 numeric(18, 2) NOT NULL CHECK (amount > 0),
    occurred_on            date NOT NULL,
    posted_on              date,
    raw_description        text NOT NULL,
    normalized_description text NOT NULL,
    memo                   text,
    import_batch_id        uuid REFERENCES import_batches (id),
    external_record_id     text,
    status                 text NOT NULL DEFAULT 'posted'
                           CHECK (status IN ('posted', 'pending', 'review', 'scheduled', 'ignored')),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    UNIQUE (import_batch_id, external_record_id)
);

-- ---------- transfer_links ----------
CREATE TABLE transfer_links (
    id                 uuid PRIMARY KEY,
    out_transaction_id uuid NOT NULL UNIQUE REFERENCES transactions (id),
    in_transaction_id  uuid NOT NULL UNIQUE REFERENCES transactions (id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (out_transaction_id <> in_transaction_id)
);

-- ---------- category_merge_map ----------
CREATE TABLE category_merge_map (
    id                    uuid PRIMARY KEY,
    old_category_id       uuid NOT NULL REFERENCES categories (id),
    canonical_category_id uuid NOT NULL REFERENCES categories (id),
    reason                text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (old_category_id, canonical_category_id)
);

-- ---------- migration_decisions ----------
CREATE TABLE migration_decisions (
    id            uuid PRIMARY KEY,
    topic         text NOT NULL UNIQUE,
    status        text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'pending', 'rejected')),
    decision      text NOT NULL,
    evidence      text,
    effective_from date,
    decided_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- reclassification_queue ----------
CREATE TABLE reclassification_queue (
    id              uuid PRIMARY KEY,
    transaction_id  uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    reason          text NOT NULL,
    proposed_target uuid REFERENCES categories (id),
    status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
    review_note     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    closed_at       timestamptz
);

-- ---------- category_assignment_audit (Fase 4B) ----------
CREATE TABLE category_assignment_audit (
    id              uuid PRIMARY KEY,
    transaction_id  uuid NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    queue_item_id   uuid REFERENCES reclassification_queue (id),
    from_category_id uuid REFERENCES categories (id),
    to_category_id  uuid NOT NULL REFERENCES categories (id),
    assigned_by     uuid,
    reason          text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- auth_users (equivalente local a auth.users do GoTrue) ----------
CREATE TABLE auth_users (
    id            uuid PRIMARY KEY,
    email         text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    profile_id    uuid NOT NULL REFERENCES profiles (id),
    display_name  text,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

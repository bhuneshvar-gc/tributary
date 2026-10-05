-- Source-side fixture for the engine integration tests. Table names
-- describe a shape (leaf, parent/child, composite, self-referencing,
-- polymorphic, custom-typed), not a business scenario.

CREATE TABLE leaf_table (
    id   int PRIMARY KEY,
    name text NOT NULL
);

CREATE TABLE parent_table (
    id   int PRIMARY KEY,
    name text NOT NULL
);

CREATE TABLE child_table (
    id        int PRIMARY KEY,
    parent_id int NOT NULL REFERENCES parent_table(id),
    name      text NOT NULL
);

-- A child with two parents: seeding one parent's child pulls in the
-- other (shared) parent, which must not fan back out to its siblings
-- under downstream-only traversal.
CREATE TABLE shared_table (
    id int PRIMARY KEY
);

CREATE TABLE member_table (
    id        int PRIMARY KEY,
    parent_id int NOT NULL REFERENCES parent_table(id),
    shared_id int NOT NULL REFERENCES shared_table(id)
);

-- Composite key: parent keyed (tenant_id, id), so two tenants can share a
-- local id and column pairing actually matters.
CREATE TABLE tenant_table (
    id int PRIMARY KEY
);

CREATE TABLE composite_parent_table (
    tenant_id int NOT NULL REFERENCES tenant_table(id),
    id        int NOT NULL,
    name      text NOT NULL,
    PRIMARY KEY (tenant_id, id)
);

CREATE TABLE composite_child_table (
    id        int PRIMARY KEY,
    parent_id int NOT NULL,
    tenant_id int NOT NULL,
    sku       text NOT NULL,
    FOREIGN KEY (parent_id, tenant_id) REFERENCES composite_parent_table(id, tenant_id)
);

-- Self-referencing, nullable: the null-then-backfill case.
CREATE TABLE self_ref_table (
    id      int PRIMARY KEY,
    next_id int REFERENCES self_ref_table(id)
);

-- Self-referencing, NOT NULL: can't be loaded NULL-first, a preflight error.
CREATE TABLE self_ref_strict_table (
    id      int PRIMARY KEY,
    next_id int NOT NULL REFERENCES self_ref_strict_table(id)
);

-- Polymorphic association, declared in config (no constraint).
CREATE TABLE poly_target_a (
    id   int PRIMARY KEY,
    name text NOT NULL
);

CREATE TABLE poly_target_b (
    id   int PRIMARY KEY,
    name text NOT NULL
);

CREATE TABLE poly_source_table (
    id          int PRIMARY KEY,
    target_type text NOT NULL,
    target_id   int NOT NULL
);

-- Enum: auto-created on target when missing.
CREATE TYPE enum_status AS ENUM ('active', 'inactive');

CREATE TABLE enum_table (
    id     int PRIMARY KEY,
    status enum_status NOT NULL
);

-- Domain: USER-DEFINED but not an enum, so a missing one is a hard error.
CREATE DOMAIN positive_int AS integer CHECK (VALUE > 0);

CREATE TABLE domain_table (
    id     int PRIMARY KEY,
    amount positive_int NOT NULL
);

-- Values whose text form must survive the copy exactly.
CREATE TABLE typed_table (
    id      bigint PRIMARY KEY,
    at      timestamptz NOT NULL,
    amount  numeric(12,4),
    code    varchar(8),
    payload jsonb,
    tags    text[],
    blob    bytea
);

-- A view must not be reported as a table.
CREATE VIEW leaf_view AS SELECT id FROM leaf_table;

-- Two tables referencing each other: loadable only with a dependency break.
CREATE TABLE cycle_a (
    id   int PRIMARY KEY,
    b_id int
);

CREATE TABLE cycle_b (
    id   int PRIMARY KEY,
    a_id int NOT NULL REFERENCES cycle_a(id)
);

ALTER TABLE cycle_a ADD CONSTRAINT cycle_a_b_fk FOREIGN KEY (b_id) REFERENCES cycle_b(id);

-- Enums outside public, and two same-named enums in different schemas.
CREATE SCHEMA billing;
CREATE TYPE billing.invoice_status AS ENUM ('draft', 'paid');
CREATE TYPE invoice_status AS ENUM ('open', 'closed');

CREATE TABLE billing.invoice (
    id      int PRIMARY KEY,
    status  billing.invoice_status NOT NULL,
    legacy  invoice_status,
    history billing.invoice_status[]
);

-- An array of an enum: the enum must be created even though the column is ARRAY.
CREATE TYPE mood AS ENUM ('happy', 'sad');

CREATE TABLE enum_array_table (
    id    int PRIMARY KEY,
    moods mood[] NOT NULL
);

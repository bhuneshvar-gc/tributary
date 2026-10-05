# Tributary

Copy **referentially-consistent subsets** of a Postgres database. Pick seed
rows; Tributary follows real foreign keys plus relations you declare, collects
every row that has to travel with them, and loads that subset into a target
database, creating missing tables and upserting on re-runs.

## Install

```sh
npm install -g @bhuneshvar-k/tributary   # Node >= 22.12
```

## Quick start

Connections, the target allowlist and AI credentials live in a local JSON
file (`tributary config path` shows where), never in your project:

```sh
tributary config set connections.prod.url  'postgres://readonly@prod-db/app'
tributary config set connections.local.url 'postgres://localhost/app_dev'
tributary config set allowlist localhost          # writable target hosts; empty = none
```

The project config is safe to commit. It names connections; it doesn't contain them:

```ts
// tributary.config.ts
import { defineConfig } from "@bhuneshvar-k/tributary";

export default defineConfig({
  source: "prod",
  target: "local",
  seed: { table: "users", where: "email = 'admin@example.com'" },
  relations: [
    // app-level FKs pg_catalog can't see
    { from: "orders.customer_ref", to: "users.id" },
    {
      from: ["line_items.tenant_id", "line_items.order_id"],
      to: ["orders.tenant_id", "orders.id"],
    },
    // polymorphic associations
    {
      from: "comments.subject_id",
      polymorphicType: "comments.subject_type",
      targets: { Post: "posts.id", Photo: "photos.id" },
    },
    // stop following a real FK
    { ignore: "audit_logs.actor_id" },
  ],
  // FK cycles to cut (loaded NULL, then backfilled)
  dependencyBreaks: [{ table: "employees", column: "manager_id" }],
});
```

```sh
tributary plan                 # row counts per table, writes nothing
tributary sync                 # copy the subset into the target
tributary sync -t orders -w "id = 42"   # override the seed
tributary ai "copy the user admin@example.com and their orders"
```

`.json` and `.yaml` config files work too (`tributary.config.json`, ...).

## How it behaves

- **Traversal.** A seed's children are followed, and so are the parents every row
  needs. By default (`traversal: "downstream"`) a parent pulled in only to satisfy a
  foreign key isn't used to fan back out to its other children. `--traversal full`
  fans out from every row.
- **Re-runs upsert.** A row that's already on the target is updated to match the
  source. `--fresh` deletes exactly the subset's rows first (never a TRUNCATE).
- **Resume.** Each table commits with its checkpoint in the target's `_tributary`
  schema, so an interrupted sync continues where it stopped.
- **Schema auto-create.** Missing target tables are created with the source's exact
  column types, NOT NULL, primary keys, foreign keys and enum types. Defaults,
  sequences, checks, indexes, triggers and non-enum custom types are not copied.
- **Cycles.** Self-references and broken cycles are loaded NULL and backfilled where
  the referenced row is in the subset; otherwise they stay NULL.
- **Exact values.** Values travel as Postgres text and are parsed by the target, so
  timestamps, numerics, bigints, JSON, arrays and bytea arrive unchanged.

## Safety

- Every source query runs in a `READ ONLY` `REPEATABLE READ` transaction: a
  consistent snapshot, and a seed predicate can't write to production.
- `sync` refuses a target whose host isn't on the allowlist (empty denies all) and
  refuses to sync a database into itself.
- `tributary ai` shows the generated command and asks before any sync (`--yes` skips).
- The local config file stores connection strings and API keys in **plaintext**.
  Keep it out of shared machines and backups you don't control.

## Library

The engine is published separately as `@bhuneshvar-k/tributary-core`:

```ts
import { parseProjectConfig, plan, sync } from "@bhuneshvar-k/tributary-core";

const result = await sync({
  source: process.env.SOURCE_URL!,
  target: process.env.TARGET_URL!,
  seed: { table: "public.users", where: "id = 42" },
  config: parseProjectConfig({ relations: [] }),
  allowlist: ["localhost"],
});
```

`inspect`, `buildGraph`, `computeClosure` and `tableOrder` are exported for
lower-level use.

## Development

```sh
pnpm install
pnpm test        # unit + integration; Postgres runs in-process via PGlite, no Docker
pnpm typecheck && pnpm lint && pnpm build
```

The Go implementation this replaces lives on as `tributary-go` (archived).

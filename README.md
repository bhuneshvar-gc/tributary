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
file, `~/.config/tributary/config.json` (`tributary config path` shows it):

```sh
tributary config set connections.prod.url  'postgres://readonly@prod-db/app'
tributary config set connections.local.url 'postgres://localhost/app_dev'
tributary config set allowlist localhost          # writable target hosts; empty = none
```

Every run is spelled out on the command line:

```sh
tributary plan -t users -w "email = 'admin@example.com'" --source prod            # row counts, writes nothing
tributary sync -t users -w "email = 'admin@example.com'" --source prod --target local
tributary sync -t users -w "id = 42" -t feature_flags --source prod --target local   # several seeds
# each -w filters the -t just before it; a -t with no (or an empty) -w takes every row
tributary ai "copy the user admin@example.com and their orders" --source prod --target local
```

## Schema file

Relationships your database doesn't declare as foreign keys (Rails/ORM
associations, polymorphic columns) go in a **schema file**. It describes the
database, not a run, so it holds no seeds or connections and can be committed:

```yaml
# schema.yaml
version: 1                  # required
defaultSchema: public       # optional; bare table names resolve here
tables:
  orders:
    references:
      customer_ref: users.id                                  # column -> table.column
  line_items:
    references:
      "tenant_id, order_id": [orders.tenant_id, orders.id]    # composite, paired in order
  comments:
    polymorphic:
      subject_id:
        typeColumn: subject_type
        targets: { Post: posts.id, Photo: media.photos.id }   # discriminator value -> table.column
  audit_logs:
    ignore: [actor_id]          # don't follow this real foreign key
  employees:
    breakCycle: [manager_id]    # cut a FK cycle: not followed, loaded NULL, backfilled
```

- **Format:** YAML or JSON, with the same structure. `"billing.invoices"`-style keys and
  `schema.table.column` targets reach other schemas.
- **Which file is used:** `--schema <file>` uses that file. Otherwise `./schema.yaml`,
  `./schema.yml` or `./schema.json` is used, the first that exists, and the run prints
  which. With no schema file, only database foreign keys are followed.
- **Start one:** `tributary schema init --source prod` writes `./schema.yaml`. It lists
  every table by its schema-qualified name (`public.orders`, public included), its real
  foreign keys as comments, and each `*_id` column without one as a bare `# order_id:`
  line. Uncomment the ones that are references and add their target; nothing is guessed.
  If the file already exists it asks `y/N` before overwriting (`--force` skips the
  question; with no terminal to ask, such as CI, it refuses unless `--force`). `-o <path>` writes elsewhere,
  and `--format json` writes JSON, which lists only the tables since JSON has no
  comments.
- **Check one:** `tributary schema validate [--schema <file>] [--source prod]` checks the
  format, and with `--source`, that every table it names (even with nothing declared
  under it) and every column exists. It exits non-zero on
  any problem, so it fits CI.

AI providers: `anthropic` (default), `openai`, `google`, `openrouter` (set `ai.model`)
and `opencode` (an OpenAI-compatible endpoint; set `ai.baseUrl` and `ai.model`).

## Updates

Every run checks npm for a newer version, alongside the command and with a short
timeout, and prints a notice on stderr when one exists:

```
Update available: 0.1.0 → 0.2.0. Run: tributary update
```

`tributary update` installs it (`npm install -g @bhuneshvar-k/tributary@<latest>`).
Nothing installs unless you run it. Turn the check off with
`tributary config set updates.check false` or `TRIBUTARY_NO_UPDATE_CHECK=1`.

## How it behaves

- **Traversal.** A seed's children are followed, and so are the parents every row
  needs. By default (`--traversal downstream`) a parent pulled in only to satisfy a
  foreign key isn't used to fan back out to its other children. `--traversal full`
  fans out from every row.
- **Bulk load, built for low load.** Rows stream from source `COPY` straight into target
  `COPY`, never parsed by Tributary, so memory holds only each row's key columns. A
  table Tributary creates is copied straight in; an existing one is staged and merged
  on its primary key. Load transactions skip waiting on WAL flushes (`synchronous_commit
  = off`, safe for any user), and loaded tables are `ANALYZE`d.
- **Re-syncs write only what changed.** A row already on the target with the same
  values is not rewritten (no new row version, almost no WAL), so a repeat sync of
  unchanged data costs the target close to nothing. `--fresh` deletes exactly the
  subset's rows first (never a TRUNCATE).
- **Live progress.** At a terminal, `plan` and `sync` show each step as it happens
  (reading the schema, collecting the subset, then each table: rows copied so far
  of the total, merging, written vs unchanged), with that step's elapsed time and
  the total. Finished steps stay on screen with how long they took, and the summary
  ends with the total time. `--json` output carries `durationMs`.
- **Re-running after a failure** streams every table again; tables that loaded fine
  are unchanged, so they cost reads but almost no writes. Each run is logged in the
  target's `_tributary.runs`.
- **Schema auto-create.** Missing target tables are created with the source's exact
  column types, NOT NULL, primary keys, foreign keys and enum types (in their own
  schemas, including enums only used in arrays). Defaults,
  sequences, checks, indexes, triggers and non-enum custom types are not copied.
- **Cycles.** Self-references and broken cycles are loaded NULL and backfilled where
  the referenced row is in the subset; otherwise they stay NULL.
- **Exact values.** Values travel as Postgres text and are parsed by the target, so
  timestamps, numerics, bigints, JSON, arrays and bytea arrive unchanged.

## Safety

- Every source query, `inspect` included, runs in a `READ ONLY` `REPEATABLE READ`
  transaction: a consistent snapshot, and nothing can write to production. Seed
  predicates are sent as a single statement, so `id = 1; COMMIT; DELETE ...` is
  rejected rather than run.
- `sync` refuses a target whose host isn't on the allowlist (empty denies all) and
  refuses to sync a database into itself: matched by server start time and database
  identity (so a pooler and a direct connection to the same database still match),
  and by cluster system identifier where the role can read it (catching a replica).
- `tributary ai` shows the generated command and asks what next: **Run it**, **Follow up**
  (type a change, e.g. "use the unilever schema", and get a revised command, as many
  rounds as you like), or **Cancel**. `--yes` runs without asking; `--dry-run` only shows
  the command. With no terminal (CI, pipes), read-only commands run and a sync needs
  `--yes`. The model looks up only the tables it needs (it never receives the whole
  schema), each round prints its token usage, and `ai.maxPromptTokens` (default 20,000)
  caps one round.
- The local config file stores connection strings and API keys in **plaintext**.
  Keep it out of shared machines and backups you don't control.

## Library

The engine is published separately as `@bhuneshvar-k/tributary-core`:

```ts
import { loadSchemaFile, plan, sync } from "@bhuneshvar-k/tributary-core";

const result = await sync({
  source: process.env.SOURCE_URL!,
  target: process.env.TARGET_URL!,
  seeds: [{ table: "public.users", where: "id = 42" }],
  schema: await loadSchemaFile("schema.yaml"), // or parseSchemaFile({ version: 1, tables: {...} })
  allowlist: ["localhost"],
});
```

`inspect`, `schemaTemplate`, `buildGraph`, `computeClosure` and `tableOrder` are
exported for lower-level use.

## Development

```sh
pnpm install
pnpm test        # unit + integration against a throwaway local Postgres (needs initdb/pg_ctl on PATH, or PG_BIN)
pnpm typecheck && pnpm lint && pnpm build
```

The Go implementation this replaces lives on as `tributary-go` (archived).

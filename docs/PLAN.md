# Tributary (TypeScript) — project plan

A referentially-consistent Postgres subsetting & sync engine, written in
TypeScript. This is a from-scratch rebuild: it carries over the **ideas and
functionality** of the Go implementation (archived as `tributary-go`), not
its CLI surface, file formats, or checkpoint format. The Go version had no
users, so there is no compatibility contract.

## Why TypeScript

- The team knows TypeScript; nobody wants to maintain Go.
- The engine should be importable as an npm library.
- The AI layer is simpler on the TS LLM SDKs.
- Code can be shared with other TS projects.

## Decisions

### Repos & packages

- The Go repo is renamed `tributary-go` and archived read-only as a
  reference.
- The new repo is `bhuneshvar-k/tributary`: a pnpm workspace with two
  packages:
  - `@bhuneshvar-k/tributary-core` is the engine library (introspect,
    closure, sync, config types). It depends on `pg` and has no AI or CLI
    dependencies.
  - `@bhuneshvar-k/tributary` is the CLI (bin: `tributary`) plus the `ai`
    command.

### Toolchain

| Concern               | Choice                                                                     |
| --------------------- | -------------------------------------------------------------------------- |
| Runtime               | Node ≥ 22.12 (active + maintenance LTS; commander 15 needs 22.12)          |
| Modules               | ESM-only, TS `strict`                                                      |
| Package manager       | pnpm workspaces                                                            |
| Library build         | `tsc` (TypeScript 6)                                                       |
| Tests                 | vitest + PGlite over `pglite-socket` (real Postgres in-process, no Docker) |
| Lint / format         | Biome                                                                      |
| CLI framework         | commander                                                                  |
| Config parsing        | zod                                                                        |
| Schema file parsing   | `yaml` + zod                                                               |
| Postgres              | `pg` + `pg-format` (`pg-logical-replication` reserved for phase 4)         |
| AI                    | Vercel AI SDK v7 structured output (`generateText` + `Output.object`)      |
| CLI UX                | `@clack/prompts`, `cli-table3`, `picocolors`                               |
| Local user config     | `conf`                                                                     |

### Configuration and schema files

1. **Local user config**: `~/.config/tributary/config.json`
   (`$XDG_CONFIG_HOME/tributary/`, `%APPDATA%\tributary\` on Windows,
   `TRIBUTARY_CONFIG_DIR` to override), owner-only permissions, managed
   with `tributary config set|get|unset|list|path`. It holds named
   connections (`connections.<name>.url`), the AI provider/model/key and
   the target allowlist. Secrets are stored in plaintext and shown
   unmasked (an accepted trade-off).

2. **Schema file** (supersedes the earlier `tributary.config.ts`): facts
   about the database that its catalog can't tell, i.e. app-level
   relations, ignores and cycle breaks (masking rules later). It holds no
   seeds, connections or run options. YAML or JSON, `version: 1`
   required, grouped by table:

   ```yaml
   version: 1
   defaultSchema: public
   tables:
     line_items:
       references:
         order_id: orders.id
         "tenant_id, cart_id": [carts.tenant_id, carts.id]
       polymorphic:
         subject_id: { typeColumn: subject_type, targets: { Post: posts.id } }
       ignore: [legacy_user_id]
       breakCycle: [parent_id]
   ```

   `--schema <file>` picks it; otherwise the first of `./schema.yaml`,
   `./schema.yml`, `./schema.json` is used (and named on stderr); with
   none, only database foreign keys are followed, with a note.
   `tributary schema init --source <name>` writes a template: every table
   schema-qualified (public included), real FKs as comments, each `*_id`
   column without one as a bare `# column:` line to fill in, nothing
   guessed, no overwrite without `--force`. `tributary schema validate`
   checks format and, with `--source`, that every named table (even an
   empty entry) and column exists. A bare seed table (`-t orders`)
   resolves in the schema file's `defaultSchema`.

3. **Run options are CLI flags**: `--source`/`--target` (required),
   repeatable `-t/--seed-table` + `-w/--where` pairs, `--traversal`,
   `--strict-cycles`, `--fresh`, `--no-create-schema`, `--json`.

### Checkpoints / resume

- State lives in a fixed `_tributary` schema in the **target** database,
  created on the first sync.
- Per-table progress is written in the same transaction as that table's
  merge, so the checkpoint can't drift from the data.
- `--fresh` resets the state rows for the run's tables, along with a
  row-scoped delete-then-reload.
- No SQLite dependency.

### Production-safety guards (enforced in code, not just documented)

- **Read-only source:** every source query runs in a `READ ONLY`,
  `REPEATABLE READ` transaction, which also gives a consistent snapshot
  across tables.
- **Source ≠ target:** the run is refused if both resolve to the same
  cluster and database (compare `system_identifier` + `datname`).
- **Target allowlist:** writes only go to hosts on the allowlist. **An empty
  allowlist denies everything**; users must `tributary config set allowlist ...`
  first.
- **AI confirmation:** `tributary ai` always prints the generated plan and
  asks y/N before any write (`--yes` skips the prompt).

### Correctness strategy

- The behavior covered by the Go `*_test.go` files is ported into vitest
  suites **first**, then built against. The cases are adapted to the new
  API, not copied verbatim. Covered areas: closure (incl. downstream-only
  default), declared relations, load/upsert, DDL/schema auto-create (incl.
  enums), AI prompt/parser, version handling.
- Integration tests run against PGlite (real Postgres compiled to WASM)
  exposed over the wire protocol, two instances per test, using
  production-shaped fixtures (enums, composite PKs, declared relations).

### Release

- npm only for now, published from GitHub Actions through **npm trusted
  publishing** (OIDC, `--provenance`, no long-lived `NPM_TOKEN`).
- No standalone binaries, Homebrew, self-updater or windows-arm64 build
  yet. npm handles installs and updates. These can be revisited later.
- First release: `0.1.0`.

## Scope

**0.1.0 ships:** phases 0–2 + AI.

| #   | Phase                                                                                                                                                                       | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 0   | Schema introspection (`tributary inspect`)                                                                                                                                  | done   |
| 1   | FK graph & subset closure incl. declared relations (`tributary plan`)                                                                                                       | done   |
| 2   | One-shot export + load: batched `INSERT … ON CONFLICT DO UPDATE` upsert, schema auto-create (columns, types, NOT NULL, PK, FK, enums), resume, `--fresh` (`tributary sync`) | done   |
| —   | Natural-language interface (`tributary ai`)                                                                                                                                 | done   |
| 3   | Masking & transform pipeline                                                                                                                                                | later  |
| 4   | Incremental sync via logical replication                                                                                                                                    | later  |
| 5   | Observability & hardening                                                                                                                                                   | later  |
| 6   | Lightweight branching (stretch)                                                                                                                                             | later  |

**Explicitly cut (unchanged from the Go plan):** automatic merge of
diverged branches, a custom CoW storage engine, non-Postgres sources.

## Build order

1. Workspace scaffold (pnpm, tsc, Biome, vitest, CI)
2. Config: local JSON store and `config set/get/list`; schema file parser, `schema init`, `schema validate`
3. Catalog: schema introspection (tables, columns, PKs, FKs, enums)
4. Graph & closure: FK graph merged with declared relations
5. Subset ordering: topological load order
6. DDL & load: schema auto-create, COPY into staging, upsert merge
7. `_tributary` state: checkpoints and resume
8. Safety guards: read-only source txn, source≠target, allowlist
9. CLI: `inspect`, `plan`, `sync`, `config`
10. AI: `ai` command on the Vercel AI SDK, with plan confirmation
11. Publish `0.1.0` via trusted publishing
12. Rename and archive the Go GitHub repo as `tributary-go`

## Reference

The Go implementation lives in `../tributary-go`. Its `docs/PLAN.md` holds
the original rationale, the phase-1 downstream-only traversal revision,
and the phase-2 upsert / schema auto-create notes.

## Implementation notes (0.1.0)

Decisions made while building, superseding the tables above where they differ:

- **No COPY.** Rows are read with every pg type parser disabled, so values
  are Postgres's own text output, and written back as untyped parameters
  in batched `INSERT … ON CONFLICT (pk) DO UPDATE` statements, which the
  target parses with its input functions. This keeps timestamps'
  microseconds, bigint/numeric precision, JSON, arrays and bytea exact
  (pg's default parsing loses some of these), needs no staging table, and
  works over PGlite. COPY can come back later as a throughput optimization.
- **Exact column types.** `inspect` records each column's `format_type()`
  (`sqlType`), and auto-created target tables use it verbatim instead of
  rebuilding type names from information_schema.
- **Deferred columns generalize self-references.** A real FK is loaded
  NULL and backfilled after all tables when it's a self-reference, a
  configured or auto-applied cycle break, or a constraint hidden by an
  `ignore` relation. Load order comes from catalog constraints only,
  restricted to the tables in the subset, so cycles elsewhere in the
  schema don't block a sync.
- **One break per cycle.** When a configured dependency break already
  cuts a multi-table cycle, the walk follows that cycle's other edges
  instead of auto-breaking each one (the Go walker broke them all).
- **Failed runs resume.** An unfinished run (interrupted _or_ failed)
  resumes from its completed tables; only a completed run or `--fresh`
  starts over.
- **Multiple seeds.** Repeat `-t/-w` pairs; one closure covers all of
  them.
- **Seed predicates are one statement.** They're interpolated (admin-tool
  trust model) but sent through the extended protocol, which Postgres
  limits to a single statement, so a predicate can't `COMMIT` its way out
  of the read-only transaction. Every source query, including `inspect`
  and the AI command's schema read, runs read-only.
- **Same-database guard.** Compares server start time + database oid +
  name (works for any role, survives poolers) and, where the role may
  read `pg_control_system()`, the cluster system identifier (catches a
  replica of the target).
- **Resume is fingerprinted.** Each table's checkpoint stores a hash of
  the rows it loaded; a resume only skips a table whose rows are
  unchanged, so source edits between attempts are never left out.
- **Enums are schema-qualified** (`schema.type`), created in their own
  schema, including enums used only as array element types.
- **Accepted additions beyond the plan:** `config unset` and `config path`,
  `*.suffix` allowlist wildcards, `TRIBUTARY_CONFIG_DIR`,
  `--no-create-schema`, `ai --dry-run`, and `ai.baseUrl`. The five AI
  providers match the Go version; `opencode` requires an explicit
  `ai.baseUrl` rather than defaulting to a guessed local port.
- **Version handling:** `--version` comes from package.json. Each run checks
  the npm registry's `latest` tag alongside the command (1.5s timeout,
  silent on failure) and prints an update notice on stderr;
  `tributary update` runs `npm install -g <package>@<latest>`. The answer
  is cached in `update-check.json` next to the user config, and
  `CHECK_INTERVAL_MS` (0 = every run for now) switches it to e.g. daily.
  Off with `updates.check false` or `TRIBUTARY_NO_UPDATE_CHECK=1`.
- **Not handled yet:** generated columns and identity `ALWAYS` columns on
  a pre-provisioned target; closure fetches are one query per row and
  edge (batching is a phase 5 item).

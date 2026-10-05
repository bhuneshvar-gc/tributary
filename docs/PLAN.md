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

| Concern | Choice |
|---|---|
| Runtime | Node ≥ 22 (active + maintenance LTS) |
| Modules | ESM-only, TS `strict` |
| Package manager | pnpm workspaces |
| Library build | tsup |
| Tests | vitest + testcontainers-node (Postgres) |
| Lint / format | Biome |
| CLI framework | commander |
| Config parsing | `yaml` + zod |
| Project config loader | jiti |
| Postgres | `pg` + `pg-copy-streams` (`pg-logical-replication` reserved for phase 4) |
| AI | Vercel AI SDK (`ai` + provider packages) |

### Configuration (two layers)

1. **Local user config**: a JSON file on the user's machine
   (e.g. `~/.config/tributary/config.json`), managed with
   `tributary config set|get|list`. It holds:
   - named connections: `connections.<name>.url` (e.g. `prod`, `local`)
   - the AI provider, model and API key
   - the target allowlist

   Secrets are stored in plaintext and shown unmasked (an accepted
   trade-off).
2. **Project config**: `tributary.config.ts`, committed alongside the app:

   ```ts
   export default defineConfig({
     source: 'prod',      // connection name from local config
     target: 'local',
     seeds: [...],        // seed predicates
     relations: [...],    // app-level FKs pg_catalog can't see
   })
   ```

   Connections are referenced by name only, so the file holds no secrets.
   The same object shape is accepted by the core library API.

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
- Integration tests run against testcontainers Postgres using
  production-shaped fixtures (enums, composite PKs, declared relations).

### Release

- npm only for now, published from GitHub Actions through **npm trusted
  publishing** (OIDC, `--provenance`, no long-lived `NPM_TOKEN`).
- No standalone binaries, Homebrew, self-updater or windows-arm64 build
  yet. npm handles installs and updates. These can be revisited later.
- First release: `0.1.0`.

## Scope

**0.1.0 ships:** phases 0–2 + AI.

| # | Phase | Status |
|---|-------|--------|
| 0 | Schema introspection (`tributary inspect`) | not started |
| 1 | FK graph & subset closure incl. declared relations (`tributary plan`) | not started |
| 2 | One-shot export + load: COPY → staging → `INSERT … ON CONFLICT DO UPDATE` upsert, schema auto-create (columns, types, NOT NULL, PK, FK, enums), resume, `--fresh` (`tributary sync`) | not started |
| — | Natural-language interface (`tributary ai`) | not started |
| 3 | Masking & transform pipeline | later |
| 4 | Incremental sync via logical replication | later |
| 5 | Observability & hardening | later |
| 6 | Lightweight branching (stretch) | later |

**Explicitly cut (unchanged from the Go plan):** automatic merge of
diverged branches, a custom CoW storage engine, non-Postgres sources.

## Build order

1. Workspace scaffold (pnpm, tsup, Biome, vitest, CI)
2. Config: zod schemas, `defineConfig`, local JSON store, `config set/get/list`
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

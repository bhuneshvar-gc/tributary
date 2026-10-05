import { type Schema, tableId } from "./catalog.js";
import type { NodeId } from "./graph.js";

/** Table -> FK columns that are loaded NULL first and backfilled afterwards. */
export type DeferredColumns = ReadonlyMap<NodeId, ReadonlySet<string>>;

/**
 * The order to load `tables` in so every real FK constraint between them
 * is satisfied row by row: parents before children (Kahn's algorithm,
 * ties broken alphabetically for determinism).
 *
 * Only catalog constraints count, since those are what the target
 * enforces; declared relations don't. Self-references and constraints
 * using a deferred column don't constrain the order. A cycle left after
 * that has no valid order and is an error naming its tables.
 */
export function tableOrder(
  schema: Schema,
  tables: Iterable<NodeId>,
  deferred: DeferredColumns = new Map(),
): NodeId[] {
  const included = new Set(tables);
  const parents = new Map<NodeId, Set<NodeId>>();
  const children = new Map<NodeId, Set<NodeId>>();
  for (const id of included) {
    parents.set(id, new Set());
    children.set(id, new Set());
  }

  for (const t of schema.tables) {
    const from = tableId(t);
    if (!included.has(from)) continue;
    for (const fk of t.foreignKeys) {
      if (fk.toTable === from || !included.has(fk.toTable)) continue;
      if (fk.fromColumns.some((c) => deferred.get(from)?.has(c))) continue;
      parents.get(from)!.add(fk.toTable);
      children.get(fk.toTable)!.add(from);
    }
  }

  const remaining = new Map([...parents].map(([id, ps]) => [id, ps.size]));
  const ready = [...remaining]
    .filter(([, n]) => n === 0)
    .map(([id]) => id)
    .sort();
  const order: NodeId[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    const freed: NodeId[] = [];
    for (const child of children.get(id)!) {
      const n = remaining.get(child)! - 1;
      remaining.set(child, n);
      if (n === 0) freed.push(child);
    }
    ready.push(...freed.sort());
  }

  if (order.length !== included.size) {
    const stuck = [...remaining]
      .filter(([, n]) => n > 0)
      .map(([id]) => id)
      .sort();
    throw new Error(
      `cannot order tables for loading: ${stuck.length} table(s) form a foreign key cycle with no dependency break: ${stuck.join(", ")}`,
    );
  }
  return order;
}

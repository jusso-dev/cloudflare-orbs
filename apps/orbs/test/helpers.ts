import { DatabaseSync } from "node:sqlite";
import { OrbStore, type KvLike, type SqlLike } from "../src/worker/store.ts";

/** A node:sqlite stand-in for Durable Object SQLite storage, enough to exercise OrbStore. */
export function createStore(): { store: OrbStore; db: DatabaseSync } {
	const db = new DatabaseSync(":memory:");
	const sql: SqlLike = {
		exec(query, ...bindings) {
			const rows = db.prepare(query).all(...bindings) as Array<Record<string, string | number | null>>;
			return {
				toArray: () => rows,
				one() {
					if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
					return rows[0]!;
				},
			};
		},
	};
	const data = new Map<string, unknown>();
	const kv: KvLike = {
		get: <T>(key: string) => data.get(key) as T | undefined,
		put: (key, value) => void data.set(key, structuredClone(value)),
		delete: (key) => data.delete(key),
	};
	const transaction = <T>(fn: () => T): T => {
		db.exec("BEGIN");
		try {
			const result = fn();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	};
	const store = new OrbStore(sql, kv, transaction);
	store.migrate();
	return { store, db };
}

// An in-memory KVNamespace, enough of one for the stores here. `pageSize` makes `list`
// page, as KV does past 1000 keys.
export interface MemoryKV extends KVNamespace {
	keys(): string[];
	ttlOf(key: string): number | undefined;
}

export function memoryKV(pageSize = 1000): MemoryKV {
	const values = new Map<string, string>();
	const ttls = new Map<string, number | undefined>();
	const kv = {
		async get(key: string, type?: 'text' | 'json') {
			const value = values.get(key);
			if (value === undefined) return null;
			return type === 'json' ? JSON.parse(value) : value;
		},
		async put(key: string, value: string, options?: { expirationTtl?: number }) {
			values.set(key, value);
			ttls.set(key, options?.expirationTtl);
		},
		async delete(key: string) {
			values.delete(key);
			ttls.delete(key);
		},
		async list(options: { prefix?: string; cursor?: string } = {}) {
			const names = [...values.keys()].filter((k) => k.startsWith(options.prefix ?? '')).sort();
			const start = options.cursor ? Number(options.cursor) : 0;
			const page = names.slice(start, start + pageSize);
			const done = start + pageSize >= names.length;
			return {
				keys: page.map((name) => ({ name })),
				list_complete: done,
				...(done ? {} : { cursor: String(start + pageSize) })
			};
		},
		keys: () => [...values.keys()].sort(),
		ttlOf: (key: string) => ttls.get(key)
	};
	return kv as unknown as MemoryKV;
}

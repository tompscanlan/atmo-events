import type { Store } from '@atcute/oauth-node-client';

/** A KV store whose keys all start with `prefix`, so group sessions and their sign-in
 *  state share `OAUTH_SESSIONS` with the library's sessions without meeting them. */
export function prefixedKV<K extends string, V>(
	kv: KVNamespace,
	prefix: string,
	opts: { ttl?: number } = {}
): Store<K, V> {
	return {
		async get(key) {
			const value = await kv.get(prefix + key, 'text');
			return value === null ? undefined : (JSON.parse(value) as V);
		},
		async set(key, value) {
			await kv.put(prefix + key, JSON.stringify(value), {
				...(opts.ttl ? { expirationTtl: opts.ttl } : {})
			});
		},
		async delete(key) {
			await kv.delete(prefix + key);
		},
		// Every key first, so a delete never shifts the listing under it.
		async clear() {
			for (const key of await listKeys(kv, prefix)) await kv.delete(prefix + key);
		}
	};
}

/** The rest of each key under `prefix`, every page. */
export async function listKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix, cursor });
		for (const { name } of page.keys) names.push(name.slice(prefix.length));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return names;
}

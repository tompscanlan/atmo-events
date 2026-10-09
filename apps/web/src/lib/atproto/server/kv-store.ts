import type { Store } from '@atcute/oauth-node-client';

/** `prefix` keeps one store's keys apart from another's in the same namespace,
 *  the way the bot keeps `bot:session:` (lib/bot/session.ts). */
export class KVStore<K extends string, V> implements Store<K, V> {
	private kv: KVNamespace;
	private expirationTtl?: number;
	private prefix: string;

	constructor(kv: KVNamespace, options?: { expirationTtl?: number; prefix?: string }) {
		this.kv = kv;
		this.expirationTtl = options?.expirationTtl;
		this.prefix = options?.prefix ?? '';
	}

	async get(key: K): Promise<V | undefined> {
		const value = await this.kv.get(this.prefix + key, 'text');
		if (value === null) return undefined;
		return JSON.parse(value) as V;
	}

	async set(key: K, value: V): Promise<void> {
		await this.kv.put(this.prefix + key, JSON.stringify(value), {
			expirationTtl: this.expirationTtl
		});
	}

	async delete(key: K): Promise<void> {
		await this.kv.delete(this.prefix + key);
	}

	/** Clears only this store's keys when it has a prefix. */
	async clear(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.kv.list({
				cursor,
				...(this.prefix ? { prefix: this.prefix } : {})
			});
			for (const key of result.keys) {
				await this.kv.delete(key.name);
			}
			cursor = result.list_complete ? undefined : result.cursor;
		} while (cursor);
	}
}

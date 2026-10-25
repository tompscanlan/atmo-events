// A prefix keeps a store's keys apart in a shared namespace: a group's linked
// session and a sign-in session are both keyed by DID in OAUTH_SESSIONS.
import { describe, it, expect } from 'vitest';
import { KVStore } from './kv-store';

function fakeKv() {
	const map = new Map<string, string>();
	const kv = {
		get: async (key: string) => map.get(key) ?? null,
		put: async (key: string, value: string) => {
			map.set(key, value);
		},
		delete: async (key: string) => {
			map.delete(key);
		},
		list: async ({ prefix = '' }: { prefix?: string } = {}) => ({
			keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
			list_complete: true
		})
	} as unknown as KVNamespace;
	return { kv, map };
}

describe('KVStore with a prefix', () => {
	it('reads and writes only under its prefix', async () => {
		const { kv, map } = fakeKv();
		map.set('did:plc:a', '"sign-in"');
		const groups = new KVStore<string, string>(kv, { prefix: 'group:session:' });

		expect(await groups.get('did:plc:a')).toBeUndefined();
		await groups.set('did:plc:a', 'linked');
		expect(await groups.get('did:plc:a')).toBe('linked');
		expect(map.get('did:plc:a')).toBe('"sign-in"');

		await groups.delete('did:plc:a');
		expect(map.has('group:session:did:plc:a')).toBe(false);
		expect(map.get('did:plc:a')).toBe('"sign-in"');
	});

	it('clears only its own keys', async () => {
		const { kv, map } = fakeKv();
		map.set('did:plc:a', '"sign-in"');
		map.set('group:session:did:plc:b', '"linked"');
		await new KVStore<string, string>(kv, { prefix: 'group:session:' }).clear();
		expect([...map.keys()]).toEqual(['did:plc:a']);
	});
});

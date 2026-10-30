import { describe, expect, it } from 'vitest';
import { memoryKV } from './__fixtures__/kv';
import { listKeys, prefixedKV } from './kv';

describe('prefixedKV', () => {
	it('reads and writes only under its prefix', async () => {
		const kv = memoryKV();
		await kv.put('k', '"not mine"');
		const store = prefixedKV<string, { a: number }>(kv, 'p:');

		await store.set('k', { a: 1 });
		expect(await kv.get('p:k', 'text')).toBe('{"a":1}');
		expect(await store.get('k')).toEqual({ a: 1 });
		expect(await store.get('missing')).toBeUndefined();

		await store.delete('k');
		expect(kv.keys()).toEqual(['k']);
	});

	it('clears its own keys and no others, across pages', async () => {
		const kv = memoryKV(2);
		await kv.put('other', '1');
		const store = prefixedKV<string, number>(kv, 'p:');
		for (const key of ['a', 'b', 'c', 'd', 'e']) await store.set(key, 1);

		await store.clear();
		expect(kv.keys()).toEqual(['other']);
	});

	it('sets the TTL only when given one', async () => {
		const kv = memoryKV();
		await prefixedKV<string, number>(kv, 's:', { ttl: 600 }).set('x', 1);
		await prefixedKV<string, number>(kv, 'n:').set('x', 1);
		expect(kv.ttlOf('s:x')).toBe(600);
		expect(kv.ttlOf('n:x')).toBeUndefined();
	});
});

describe('listKeys', () => {
	it('returns the rest of each key under the prefix, every page', async () => {
		const kv = memoryKV(2);
		for (const key of ['p:1', 'p:2', 'p:3', 'q:1']) await kv.put(key, '1');
		expect(await listKeys(kv, 'p:')).toEqual(['1', '2', '3']);
	});
});

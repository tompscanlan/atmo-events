// The picture a create at the host waits with. It must outlast the sign-up's
// state, be taken once, and never come back as a type the profile would not take.
import { describe, expect, it } from 'vitest';

import { kvAvatarStash } from './avatar-stash';

/** A KV namespace in memory, keeping each value's options as it was put. */
function memoryKv() {
	const values = new Map<
		string,
		{ value: ArrayBuffer; options: { expirationTtl?: number; metadata?: unknown } }
	>();
	const kv = {
		async put(
			key: string,
			value: ArrayBuffer,
			options: { expirationTtl?: number; metadata?: unknown }
		) {
			values.set(key, { value, options });
		},
		async getWithMetadata(key: string) {
			const kept = values.get(key);
			return { value: kept?.value ?? null, metadata: kept?.options.metadata ?? null };
		},
		async delete(key: string) {
			values.delete(key);
		}
	};
	return { kv: kv as unknown as KVNamespace, values };
}

const bytes = new Uint8Array([1, 2, 3]);

describe('kvAvatarStash', () => {
	it('keeps the image past the state, and gives it back once', async () => {
		const { kv, values } = memoryKv();
		const stash = kvAvatarStash(kv);

		const key = await stash.put(new Blob([bytes], { type: 'image/png' }));

		const [kept] = values.values();
		expect(kept.options.expirationTtl).toBeGreaterThan(600);
		const image = await stash.take(key);
		expect(image?.type).toBe('image/png');
		expect(new Uint8Array(await image!.arrayBuffer())).toEqual(bytes);
		expect(await stash.take(key)).toBeNull();
		expect(values.size).toBe(0);
	});

	it('reads a stored type the profile would not take as gone', async () => {
		const { kv } = memoryKv();
		const stash = kvAvatarStash(kv);

		const key = await stash.put(new Blob([bytes], { type: 'text/html' }));

		expect(await stash.take(key)).toBeNull();
	});
});

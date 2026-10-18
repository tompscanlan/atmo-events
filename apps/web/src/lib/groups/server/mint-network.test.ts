import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/public', () => ({
	env: { PUBLIC_ATPROTO_PLC_URL: 'https://plc.lighthouse.snowglobe.at' }
}));

import { assertOwnerHoldsRotationKey } from './mint';

describe('assertOwnerHoldsRotationKey on a private network', () => {
	afterEach(() => vi.unstubAllGlobals());

	it("reads the genesis operation from the network's directory", async () => {
		const asked: string[] = [];
		vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
			asked.push(String(input));
			return new Response(JSON.stringify({ rotationKeys: ['did:key:owner'] }));
		});

		await assertOwnerHoldsRotationKey('did:plc:abc', 'did:key:owner');

		expect(asked).toEqual(['https://plc.lighthouse.snowglobe.at/did:plc:abc/data']);
	});
});

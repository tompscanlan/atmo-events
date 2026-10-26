import { describe, expect, it, vi } from 'vitest';

const { configureAtproto } = vi.hoisted(() => ({ configureAtproto: vi.fn() }));
vi.mock('@atmo-dev/events-ui', () => ({ configureAtproto }));

import { load } from './+layout';

describe('root layout load', () => {
	it("configures the components and passes the server layout's data on", () => {
		const data = { did: 'did:plc:abc', profile: null };
		const event = { data } as unknown as Parameters<typeof load>[0];

		// Its return value replaces the server layout's data, so pages would lose who is signed in.
		expect(load(event)).toBe(data);
		expect(configureAtproto).toHaveBeenCalledWith({
			imageUrlTemplate: 'https://cdn.bsky.app/img/feed_thumbnail/plain/{did}/{cid}@{format}',
			appviewUrl: 'https://public.api.bsky.app'
		});
	});
});

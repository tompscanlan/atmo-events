import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

const mocks = vi.hoisted(() => ({ networkFetch: vi.fn<typeof fetch>() }));
vi.mock('#lib/atproto/network.js', () => ({
	atprotoNetwork: () => ({
		fetch: (input: RequestInfo | URL, init?: RequestInit) => mocks.networkFetch(input, init),
		isolated: false,
		assertUrl: () => {}
	})
}));

import { newGroupUrl } from './host-api';

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example/' });
});

describe("the group host's page for making a group", () => {
	it("is its console's page at its own address, from the setting alone, with no call to it", () => {
		expect(newGroupUrl()).toBe('https://host.example/new');
		Object.assign(env, { GROUP_HOST_URL: 'https://host.example:8443/some/path?x=1' });
		expect(newGroupUrl()).toBe('https://host.example:8443/new');
		expect(mocks.networkFetch).not.toHaveBeenCalled();
	});

	it('is none with groups off', () => {
		Object.assign(env, { GROUP_HOST_URL: ' ' });
		expect(newGroupUrl()).toBeNull();
	});
});

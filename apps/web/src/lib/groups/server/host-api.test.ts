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

import { forgetGroupHostInfo, groupHostInfo } from './host-api';

const described = (body: Record<string, unknown>) =>
	mocks.networkFetch.mockImplementation(async () => Response.json(body));

beforeEach(() => {
	vi.resetAllMocks();
	forgetGroupHostInfo();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example/' });
});

describe('the group host, as it describes itself', () => {
	it("takes the host's DID and its groups' domain from describeServer, and asks once", async () => {
		described({
			did: 'did:web:host.example',
			availableUserDomains: ['.Groups.Example'],
			inviteCodeRequired: true
		});
		const expected = {
			origin: 'https://host.example',
			did: 'did:web:host.example',
			domain: '.groups.example',
			newGroupUrl: 'https://host.example/new'
		};
		expect(await groupHostInfo()).toEqual(expected);
		expect(await groupHostInfo()).toEqual(expected);
		expect(mocks.networkFetch).toHaveBeenCalledOnce();
		expect(String(mocks.networkFetch.mock.calls[0][0])).toBe(
			'https://host.example/xrpc/com.atproto.server.describeServer'
		);
	});

	it('asks again for another host', async () => {
		described({ did: 'did:web:host.example', availableUserDomains: ['.groups.example'] });
		await groupHostInfo();
		Object.assign(env, { GROUP_HOST_URL: 'https://other.example' });
		described({ did: 'did:web:other.example', availableUserDomains: ['.other.example'] });
		expect((await groupHostInfo()).did).toBe('did:web:other.example');
	});

	it.each([
		['no DID', { availableUserDomains: ['.groups.example'] }, 'names no DID'],
		['no domain', { did: 'did:web:host.example', availableUserDomains: [] }, 'names no domain'],
		[
			'a domain without its dot',
			{ did: 'did:web:host.example', availableUserDomains: ['x.y'] },
			'names no domain'
		]
	])('throws for an answer with %s', async (_why, body, message) => {
		described(body);
		await expect(groupHostInfo()).rejects.toThrow(message);
	});

	it.each([
		['another host', 'did:web:other.example'],
		['a DID that is not its did:web', 'did:plc:host'],
		['its domain with a path', 'did:web:host.example:path']
	])('refuses, and says why, a host that names %s as its DID', async (_why, did) => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		described({ did, availableUserDomains: ['.groups.example'] });
		await expect(groupHostInfo()).rejects.toThrow(did);
		expect(String(logged.mock.calls[0]?.[0])).toContain(did);
	});

	it('takes the did:web of an address with a port, its colon encoded', async () => {
		Object.assign(env, { GROUP_HOST_URL: 'https://Host.Example:8443' });
		described({ did: 'did:web:host.example%3A8443', availableUserDomains: ['.groups.example'] });
		expect((await groupHostInfo()).did).toBe('did:web:host.example%3A8443');
	});

	it('throws when the host does not answer, or there is none', async () => {
		mocks.networkFetch.mockImplementation(async () => new Response('down', { status: 502 }));
		await expect(groupHostInfo()).rejects.toThrow('com.atproto.server.describeServer failed: 502');
		Reflect.deleteProperty(env, 'GROUP_HOST_URL');
		await expect(groupHostInfo()).rejects.toThrow('no group host');
	});
});

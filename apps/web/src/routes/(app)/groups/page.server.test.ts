import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

const mocks = vi.hoisted(() => ({ browseGroups: vi.fn(), available: vi.fn() }));
vi.mock('#lib/groups/server/browse.js', () => ({ browseGroups: mocks.browseGroups }));
vi.mock('#lib/groups/server/sign-in.js', () => ({ groupSignInAvailable: mocks.available }));

import { load } from './+page.server';

const request = (query = '') =>
	({
		locals: { did: null },
		url: new URL(`https://atmo.example/groups${query}`)
	}) as unknown as Parameters<typeof load>[0];

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	mocks.browseGroups.mockResolvedValue({
		groups: [],
		cursor: null,
		declaredUnavailable: false,
		crowded: [{ server: 'https://pds.example:8443', more: 4 }]
	});
});

describe('the groups list', () => {
	it('names each crowded server by its host', async () => {
		const page = await load(request());
		expect(mocks.browseGroups).toHaveBeenCalledWith(null, { cursor: null, server: null });
		expect(page).toMatchObject({
			server: null,
			crowded: [{ server: 'https://pds.example:8443', host: 'pds.example:8443', more: 4 }]
		});
	});

	it("shows one server's groups for an origin, and is a 404 for anything else", async () => {
		const page = await load(request('?server=https%3A%2F%2Fpds.example&cursor=c'));
		expect(mocks.browseGroups).toHaveBeenCalledWith(null, {
			cursor: 'c',
			server: 'https://pds.example'
		});
		expect(page).toMatchObject({
			pageTitle: 'Groups at pds.example',
			server: { origin: 'https://pds.example', host: 'pds.example' }
		});

		for (const server of ['', 'pds.example', 'https://pds.example/', 'ftp://pds.example']) {
			await expect(load(request(`?${new URLSearchParams({ server })}`))).rejects.toMatchObject({
				status: 404
			});
		}
	});

	it('is a 404 with groups off', async () => {
		Reflect.deleteProperty(env, 'GROUP_HOST_URL');
		await expect(load(request())).rejects.toMatchObject({ status: 404 });
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

const mocks = vi.hoisted(() => ({ groupView: vi.fn(), hostingQuery: vi.fn() }));
vi.mock('#lib/groups/server/context.js', () => ({ groupView: mocks.groupView }));
vi.mock('#lib/contrail/queries.js', () => ({ hostingQuery: mocks.hostingQuery }));
vi.mock('#lib/contrail/index.js', () => ({ getServerClient: () => ({}) }));

import { load } from './+page.server';

const GROUP = 'did:plc:group';
const request = (query = '') =>
	({
		params: { actor: GROUP },
		locals: { did: null },
		url: new URL(`https://atmo.example/groups/${GROUP}${query}`),
		setHeaders: vi.fn()
	}) as unknown as Parameters<typeof load>[0];

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', description: null });
	mocks.hostingQuery.mockResolvedValue({ events: [], cursor: null });
});

describe('a group page', () => {
	it('shows only its own notices, so a made-up ?link= is no notice at all', async () => {
		expect((await load(request('?link=linked'))).notice).toEqual(expect.any(String));
		for (const link of ['toString', 'constructor', '__proto__', 'nope']) {
			expect((await load(request(`?link=${link}`))).notice).toBeNull();
		}
	});
});

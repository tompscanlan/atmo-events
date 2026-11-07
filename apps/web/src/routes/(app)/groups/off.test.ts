// With groups off, the group pages answer as addresses this site never had: the 404 carries no header
// of their own, and no page's data says anything about groups.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

const mocks = vi.hoisted(() => ({ groupView: vi.fn() }));
vi.mock('#lib/groups/server/context.js', () => ({
	GROUP_NOT_FOUND: 'Group not found',
	groupView: mocks.groupView
}));
vi.mock('#lib/groups/server/browse.js', () => ({ browseGroups: vi.fn() }));
vi.mock('#lib/contrail/index.js', () => ({ getServerClient: () => ({}) }));
vi.mock('#lib/contrail/queries.js', () => ({ hostingQuery: vi.fn() }));
vi.mock('#lib/contrail.js', () => ({
	flattenEventRecord: vi.fn(),
	getEventRecordFromContrail: vi.fn()
}));

import { load as list } from './+page.server';
import { load as group } from './[actor]/+page.server';
import { load as newEvent } from './[actor]/events/new/+page.server';
import { load as editEvent } from './[actor]/events/[rkey]/edit/+page.server';
import { load as layout } from '../+layout.server';

const GROUP = 'did:plc:group';

function request(path: string) {
	const setHeaders = vi.fn();
	return {
		setHeaders,
		event: {
			params: { actor: GROUP, rkey: 'a' },
			locals: { did: 'did:plc:alice' },
			url: new URL(`https://atmo.example${path}`),
			cookies: {},
			setHeaders
		} as never
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.groupView.mockResolvedValue({ did: GROUP, name: 'Knitters', linked: null });
});

describe('with groups off', () => {
	it('answers every group page with a bare 404, before any header of its own', async () => {
		for (const [path, load] of [
			['/groups', list],
			[`/groups/${GROUP}`, group],
			[`/groups/${GROUP}/events/new`, newEvent],
			[`/groups/${GROUP}/events/a/edit`, editEvent]
		] as const) {
			const { setHeaders, event } = request(path);
			await expect((load as (e: never) => Promise<unknown>)(event)).rejects.toMatchObject({
				status: 404
			});
			expect(setHeaders, path).not.toHaveBeenCalled();
		}
	});

	it("leaves groups out of every page's data", () => {
		expect('groupsEnabled' in layout()).toBe(false);
		Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
		expect(layout()).toMatchObject({ groupsEnabled: true });
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

const mocks = vi.hoisted(() => ({ groupView: vi.fn(), getEventRecordFromContrail: vi.fn() }));
vi.mock('#lib/groups/server/context.js', async (importActual) => ({
	...(await importActual<typeof import('#lib/groups/server/context.js')>()),
	groupView: mocks.groupView
}));
vi.mock('#lib/contrail/index.js', () => ({ getServerClient: () => ({}) }));
vi.mock('#lib/contrail.js', () => ({
	getEventRecordFromContrail: mocks.getEventRecordFromContrail,
	flattenEventRecord: (record: unknown) => record
}));

import { load as newEvent } from './new/+page.server';
import { load as editEvent } from './[rkey]/edit/+page.server';

const GROUP = 'did:plc:group';
const request = () =>
	({
		params: { actor: GROUP, rkey: 'r' },
		locals: { did: 'did:plc:alice' },
		setHeaders: vi.fn()
	}) as never;

const linked = (post: boolean) => ({
	did: GROUP,
	handle: 'knit.example',
	name: 'Knitters',
	linked: { meta: { profile: null, public: true }, listed: false, can: { post, list: post } }
});

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	mocks.getEventRecordFromContrail.mockResolvedValue({ name: 'Meet' });
});

describe('posting and editing as the group', () => {
	it('opens the editor for a link whose scope posts', async () => {
		mocks.groupView.mockResolvedValue(linked(true));
		expect(await newEvent(request())).toMatchObject({ group: { did: GROUP } });
		expect(await editEvent(request())).toMatchObject({ eventData: { name: 'Meet' } });
	});

	it("says so, rather than opening an editor that can't save, for a link that may not post", async () => {
		mocks.groupView.mockResolvedValue(linked(false));
		for (const load of [newEvent, editEvent]) {
			await expect((load as (e: never) => Promise<unknown>)(request())).rejects.toMatchObject({
				status: 403,
				body: { message: "Your role in this group doesn't let you post its events." }
			});
		}
	});

	it('is the same 404 without a working link', async () => {
		mocks.groupView.mockResolvedValue({ ...linked(true), linked: null });
		for (const load of [newEvent, editEvent]) {
			await expect((load as (e: never) => Promise<unknown>)(request())).rejects.toMatchObject({
				status: 404
			});
		}
	});
});

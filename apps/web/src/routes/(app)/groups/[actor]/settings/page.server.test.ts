import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { XrpcError } from '#lib/groups/server/xrpc.js';

const mocks = vi.hoisted(() => ({
	groupView: vi.fn(),
	requireGroupWriter: vi.fn(),
	readGroupSettings: vi.fn()
}));
vi.mock('#lib/groups/server/context.js', async (importActual) => ({
	...(await importActual<typeof import('#lib/groups/server/context.js')>()),
	groupView: mocks.groupView,
	requireGroupWriter: mocks.requireGroupWriter
}));
vi.mock('#lib/groups/server/settings.js', () => ({ readGroupSettings: mocks.readGroupSettings }));

import { load } from './+page.server';

const GROUP = 'did:plc:group';
const request = () =>
	({
		params: { actor: GROUP },
		locals: { did: 'did:plc:alice' },
		setHeaders: vi.fn()
	}) as never;

const linked = (settings: boolean, reapprove = false) => ({
	did: GROUP,
	name: 'Night Riders',
	linked: {
		meta: { profile: null, public: true },
		listed: true,
		can: { post: true, list: true, settings },
		reapprove,
		unfinished: false
	}
});

const SETTINGS = {
	name: 'Night Riders',
	description: null,
	website: null,
	joinPolicy: 'approval',
	public: true,
	listed: true
};

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	mocks.requireGroupWriter.mockResolvedValue({ did: GROUP, handle: vi.fn() });
	mocks.readGroupSettings.mockResolvedValue(SETTINGS);
});

describe("a group's settings page", () => {
	it('starts from the settings as they are, for a link that may change them', async () => {
		mocks.groupView.mockResolvedValue(linked(true));
		expect(await load(request())).toMatchObject({
			group: { did: GROUP, name: 'Night Riders' },
			reapprove: false,
			settings: SETTINGS
		});
	});

	it('offers to approve the link again when it was approved before settings were asked for', async () => {
		mocks.groupView.mockResolvedValue(linked(false, true));
		expect(await load(request())).toMatchObject({ reapprove: true });
		expect(mocks.readGroupSettings).not.toHaveBeenCalled();
	});

	it("says so for a link whose roles don't let it, approved for everything asked", async () => {
		mocks.groupView.mockResolvedValue(linked(false));
		await expect(load(request())).rejects.toMatchObject({
			status: 403,
			body: { message: "Your role in this group doesn't let you change its settings." }
		});
	});

	it('is the same 404 without a working link', async () => {
		mocks.groupView.mockResolvedValue({ ...linked(true), linked: null });
		await expect(load(request())).rejects.toMatchObject({ status: 404 });
	});

	it('says so, rather than failing, when the host refuses the read', async () => {
		mocks.groupView.mockResolvedValue(linked(true));
		mocks.readGroupSettings.mockRejectedValue(
			new XrpcError('com.atproto.space.getDelegationToken', 403, 'NotAuthorized')
		);
		await expect(load(request())).rejects.toMatchObject({ status: 403 });
	});
});

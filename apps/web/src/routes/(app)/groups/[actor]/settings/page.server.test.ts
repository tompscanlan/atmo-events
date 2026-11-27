import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { GROUP_NOT_FOUND, NO_SETTINGS } from '#lib/groups/server/context.js';
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
/** The page is tested with it in the build, and once without. */
const build = vi.hoisted(() => ({ settings: true }));
vi.mock('#lib/groups/build.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/groups/build.js')>()),
	get SETTINGS_IN_THIS_BUILD() {
		return build.settings;
	}
}));

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
		unfinished: null
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
	build.settings = true;
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
		expect(mocks.readGroupSettings).not.toHaveBeenCalled();
	});

	it('is the 404 of a group that does not exist, without a working link', async () => {
		mocks.groupView.mockResolvedValue({ ...linked(true), linked: null });
		await expect(load(request())).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});
		expect(mocks.readGroupSettings).not.toHaveBeenCalled();
	});

	it('says so, rather than failing, when the host refuses the read', async () => {
		mocks.groupView.mockResolvedValue(linked(true));
		mocks.readGroupSettings.mockRejectedValue(
			new XrpcError('com.atproto.space.getDelegationToken', 403, 'NotAuthorized')
		);
		await expect(load(request())).rejects.toMatchObject({
			status: 403,
			body: { message: NO_SETTINGS }
		});
	});
});

describe('in a build without the settings page', () => {
	it("is groups-off's 404, with groups on, before reading the group", async () => {
		build.settings = false;
		mocks.groupView.mockResolvedValue(linked(true));
		await expect(load(request())).rejects.toMatchObject({
			status: 404,
			body: { message: 'Not Found' }
		});
		expect(mocks.groupView).not.toHaveBeenCalled();
		expect(mocks.readGroupSettings).not.toHaveBeenCalled();
	});
});

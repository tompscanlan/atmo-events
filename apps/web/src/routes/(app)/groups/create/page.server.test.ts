import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { isActionFailure } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
	available: vi.fn(),
	callerSession: vi.fn(),
	groupHostInfo: vi.fn(),
	createGroupAtHost: vi.fn(),
	rememberUnfinished: vi.fn(),
	unfinishedGroups: vi.fn(),
	startGroupLink: vi.fn(),
	ownGroupNotNoted: vi.fn()
}));
vi.mock('#lib/groups/server/sign-in.js', () => ({
	groupSignInAvailable: mocks.available,
	startGroupLink: mocks.startGroupLink
}));
vi.mock('#lib/private-events/server/caller.js', () => ({ callerSession: mocks.callerSession }));
vi.mock('#lib/groups/server/host-api.js', async (importActual) => ({
	...(await importActual<typeof import('#lib/groups/server/host-api.js')>()),
	groupHostInfo: mocks.groupHostInfo
}));
vi.mock('#lib/groups/server/create.js', async (importActual) => ({
	...(await importActual<typeof import('#lib/groups/server/create.js')>()),
	createGroupAtHost: mocks.createGroupAtHost,
	rememberUnfinished: mocks.rememberUnfinished,
	unfinishedGroups: mocks.unfinishedGroups,
	ownGroupNotNoted: mocks.ownGroupNotNoted
}));
/** The page is tested with making groups here in the build, and once without. */
const build = vi.hoisted(() => ({ create: true }));
vi.mock('#lib/groups/build.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/groups/build.js')>()),
	get CREATE_IN_THIS_BUILD() {
		return build.create;
	}
}));

import { GroupNotCreated } from '#lib/groups/server/create.js';
import { actions, load } from './+page.server';

const ALICE = 'did:plc:alice';
const GROUP = 'did:plc:group';
const HOST = {
	origin: 'https://host.example',
	did: 'did:web:host.example',
	domain: '.groups.example',
	newGroupUrl: 'https://host.example/new'
};
const ALLOWED = 'atproto rpc:org.atgrp.internal.createGroup?aud=*';

const loadAs = (did: string | null, query = '') =>
	load({
		locals: { did, session: {} },
		url: new URL(`https://atmo.example/groups/create${query}`),
		setHeaders: vi.fn()
	} as never);

function post(fields: Record<string, string>, did: string | null = ALICE) {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.set(name, value);
	return actions.default({
		request: new Request('https://atmo.example/groups/create', { method: 'POST', body }),
		locals: { did, session: {} }
	} as never);
}

const FORM = {
	name: 'Night Riders',
	address: 'riders',
	description: 'We ride at night.',
	joinPolicy: 'approval',
	visibility: 'public'
};

beforeEach(() => {
	vi.resetAllMocks();
	build.create = true;
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	mocks.available.mockReturnValue(true);
	mocks.groupHostInfo.mockResolvedValue(HOST);
	mocks.callerSession.mockResolvedValue({ did: ALICE, scope: ALLOWED, handle: vi.fn() });
	mocks.unfinishedGroups.mockResolvedValue([]);
	mocks.createGroupAtHost.mockResolvedValue({ did: GROUP, handle: 'riders.groups.example' });
	mocks.startGroupLink.mockResolvedValue(new URL('https://host.example/oauth/authorize?r=1'));
});

describe('the make-a-group page', () => {
	it('sends someone signed out to sign in', async () => {
		await expect(loadAs(null)).rejects.toMatchObject({ status: 303, location: '/login' });
	});

	it("names the host's domain, and offers the form to someone who may make a group", async () => {
		expect(await loadAs(ALICE)).toMatchObject({
			available: true,
			host: { domain: '.groups.example', newGroupUrl: 'https://host.example/new' },
			access: null,
			unfinished: []
		});
	});

	it('asks for the permission first, and says when their server did not give it', async () => {
		mocks.callerSession.mockResolvedValue({ did: ALICE, scope: 'atproto', handle: vi.fn() });
		expect(await loadAs(ALICE)).toMatchObject({ access: 'ask' });
		expect(await loadAs(ALICE, `?asked=${ALICE}`)).toMatchObject({ access: 'refused' });
	});

	it('takes only a permission for this host: one for another is asked for again, and nothing is made with it', async () => {
		const elsewhere = 'atproto rpc?lxm=org.atgrp.internal.createGroup&aud=did:web:other.example';
		mocks.callerSession.mockResolvedValue({ did: ALICE, scope: elsewhere, handle: vi.fn() });
		expect(await loadAs(ALICE)).toMatchObject({ access: 'ask' });
		expect(await post(FORM)).toMatchObject({ status: 403, data: { reason: 'no-permission' } });
		expect(mocks.createGroupAtHost).not.toHaveBeenCalled();
		const here = 'atproto rpc?lxm=org.atgrp.internal.createGroup&aud=did:web:host.example';
		mocks.callerSession.mockResolvedValue({ did: ALICE, scope: here, handle: vi.fn() });
		expect(await loadAs(ALICE)).toMatchObject({ access: null });
	});

	it('lists the groups they made and have not linked yet, to finish', async () => {
		mocks.unfinishedGroups.mockResolvedValue([{ did: GROUP, handle: 'riders.groups.example' }]);
		expect((await loadAs(ALICE)).unfinished).toEqual([
			{ did: GROUP, handle: 'riders.groups.example' }
		]);
	});

	it('says the host could not be reached rather than failing', async () => {
		mocks.groupHostInfo.mockRejectedValue(new Error('down'));
		expect(await loadAs(ALICE)).toMatchObject({ host: null });
	});
});

describe('making a group', () => {
	it('makes it at the host, notes it, and sends the browser to approve atmo as it', async () => {
		await expect(post(FORM)).rejects.toMatchObject({
			status: 303,
			location: 'https://host.example/oauth/authorize?r=1'
		});
		expect(mocks.createGroupAtHost).toHaveBeenCalledWith(
			expect.objectContaining({ did: ALICE }),
			{
				name: 'Night Riders',
				address: 'riders',
				description: 'We ride at night.',
				joinPolicy: 'approval',
				public: true
			},
			HOST
		);
		expect(mocks.rememberUnfinished).toHaveBeenCalledWith(ALICE, {
			did: GROUP,
			handle: 'riders.groups.example'
		});
		expect(mocks.startGroupLink).toHaveBeenCalledWith(GROUP, ALICE);
	});

	it('keeps what was typed, and says why, for a form it cannot take', async () => {
		const failed = await post({ ...FORM, address: 'night riders' });
		expect(isActionFailure(failed)).toBe(true);
		expect(failed).toMatchObject({
			status: 400,
			data: { values: { address: 'night riders' }, message: expect.stringContaining('address') }
		});
		expect(mocks.createGroupAtHost).not.toHaveBeenCalled();
	});

	it.each([
		['not-allowed', 403, 'limits who may'],
		['address-taken', 400, 'taken'],
		['address-invalid', 400, 'address'],
		['unavailable', 502, 'reached']
	] as const)('says so in plain words when the host refuses: %s', async (reason, status, words) => {
		mocks.createGroupAtHost.mockRejectedValue(new GroupNotCreated(reason));
		expect(await post(FORM)).toMatchObject({
			status,
			data: { reason, message: expect.stringContaining(words), values: { name: 'Night Riders' } }
		});
		expect(mocks.rememberUnfinished).not.toHaveBeenCalled();
	});

	it.each([
		['the address is taken', new GroupNotCreated('address-taken')],
		["the host's answer never came", new GroupNotCreated('unavailable', true)]
	])('offers to finish a group the person made a moment ago when %s', async (_when, refusal) => {
		const made = { did: GROUP, handle: 'riders.groups.example' };
		mocks.createGroupAtHost.mockRejectedValue(refusal);
		mocks.ownGroupNotNoted.mockResolvedValue(made);
		const failed = await post(FORM);
		expect(failed).toMatchObject({
			status: 409,
			data: { reason: 'made-already', made, values: { name: 'Night Riders' } }
		});
		expect((failed as { data: { message: string } }).data.message).toContain(
			'Finish setting it up'
		);
		expect(mocks.ownGroupNotNoted).toHaveBeenCalledWith(
			expect.objectContaining({ did: ALICE }),
			expect.objectContaining({ address: 'riders', name: 'Night Riders' }),
			HOST
		);
		// Noted, so it is offered among those not set up yet.
		expect(mocks.rememberUnfinished).toHaveBeenCalledWith(ALICE, made);
	});

	it('says the address is taken, or the host could not be reached, for a group not theirs', async () => {
		mocks.ownGroupNotNoted.mockResolvedValue(null);
		mocks.createGroupAtHost.mockRejectedValue(new GroupNotCreated('address-taken'));
		expect(await post(FORM)).toMatchObject({ status: 400, data: { reason: 'address-taken' } });
		mocks.createGroupAtHost.mockRejectedValue(new GroupNotCreated('unavailable', true));
		expect(await post(FORM)).toMatchObject({ status: 502, data: { reason: 'unavailable' } });
		expect(mocks.rememberUnfinished).not.toHaveBeenCalled();
		// A refusal that made nothing needs no look.
		mocks.ownGroupNotNoted.mockClear();
		mocks.createGroupAtHost.mockRejectedValue(new GroupNotCreated('unavailable'));
		await post(FORM);
		expect(mocks.ownGroupNotNoted).not.toHaveBeenCalled();
	});

	it('leaves a way back when the link cannot start after the group is made', async () => {
		mocks.startGroupLink.mockRejectedValue(new Error('no route to the host'));
		await expect(post(FORM)).rejects.toMatchObject({ status: 303, location: '/groups/create' });
		expect(mocks.rememberUnfinished).toHaveBeenCalled();
	});
});

describe('in a build without making groups here', () => {
	it("is groups-off's 404, with groups on, for the page and its form alike, and makes nothing", async () => {
		build.create = false;
		const notFound = { status: 404, body: { message: 'Not Found' } };
		await expect(loadAs(ALICE)).rejects.toMatchObject(notFound);
		await expect(post(FORM)).rejects.toMatchObject(notFound);
		expect(mocks.createGroupAtHost).not.toHaveBeenCalled();
		expect(mocks.rememberUnfinished).not.toHaveBeenCalled();
		expect(mocks.startGroupLink).not.toHaveBeenCalled();
	});
});

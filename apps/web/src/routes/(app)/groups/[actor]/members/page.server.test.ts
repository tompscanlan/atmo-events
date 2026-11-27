import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { SpaceAccessDenied } from '#lib/spaces/server/space-credential.js';

const mocks = vi.hoisted(() => ({
	groupView: vi.fn(),
	requireGroupWriter: vi.fn(),
	callerSession: vi.fn(),
	readRoster: vi.fn(),
	listJoinRequests: vi.fn()
}));
vi.mock('#lib/groups/server/context.js', async (importActual) => ({
	...(await importActual<typeof import('#lib/groups/server/context.js')>()),
	groupView: mocks.groupView,
	requireGroupWriter: mocks.requireGroupWriter
}));
vi.mock('#lib/private-events/server/caller.js', () => ({ callerSession: mocks.callerSession }));
vi.mock('#lib/groups/server/roster.js', () => ({
	readRoster: mocks.readRoster,
	listJoinRequests: mocks.listJoinRequests
}));

import { load } from './+page.server';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';
const CAROL = 'did:plc:carol';
const CONFIRMS = `space:org.atgrp.members?authority=*&skey=self&collection=org.atgrp.confirmation`;
const person = { did: ALICE, scope: `atproto ${CONFIRMS}`, handle: vi.fn() };
const writer = { did: GROUP, handle: vi.fn() };

const request = (query = '', did: string | null = ALICE) =>
	({
		params: { actor: GROUP },
		locals: { did, session: did ? {} : null },
		url: new URL(`https://atmo.example/groups/${GROUP}/members${query}`),
		setHeaders: vi.fn()
	}) as unknown as Parameters<typeof load>[0];

const NONE = { admit: false, assign: false, remove: false };
const ALL = { admit: true, assign: true, remove: true };
const view = (over: Record<string, unknown> = {}) => ({
	did: GROUP,
	name: 'Night Riders',
	personal: { profile: null, public: true, joinPolicy: 'approval' },
	member: true,
	linked: null,
	askAccess: false,
	...over
});
const linked = (can: typeof ALL, reapprove = false) => ({
	meta: { profile: null, public: true },
	listed: true,
	can: { post: true, list: true, settings: true, ...can },
	reapprove,
	unfinished: null
});

const entry = (did: string, roles: string[], confirmed: boolean | null) => ({
	did,
	handle: null,
	roles,
	createdAt: 'x',
	confirmed
});
const ROSTER = {
	entries: [entry(ALICE, ['member', 'admin'], true), entry(BOB, ['member'], false)],
	roles: [
		{ id: 'admin', name: 'Admin' },
		{ id: 'member', name: 'Member' }
	],
	yours: ['member', 'admin']
};
const REQUESTS = [{ did: CAROL, handle: null, message: 'I ride.', createdAt: 'x' }];

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	mocks.callerSession.mockResolvedValue(person);
	mocks.groupView.mockResolvedValue(view());
	mocks.requireGroupWriter.mockResolvedValue(writer);
	mocks.readRoster.mockResolvedValue(ROSTER);
	mocks.listJoinRequests.mockResolvedValue(REQUESTS);
});

describe("a group's members page", () => {
	it('shows a member the confirmed members and their roles, read with their own access, and no controls', async () => {
		const page = await load(request());
		expect(mocks.groupView).toHaveBeenCalledWith(GROUP, ALICE, person);
		expect(mocks.readRoster).toHaveBeenCalledWith(person, GROUP, null);
		expect(page).toMatchObject({
			state: 'roster',
			listed: [ROSTER.entries[0]],
			unconfirmed: [],
			roles: ROSTER.roles,
			yours: ['member', 'admin'],
			manage: NONE,
			requests: null,
			reapprove: false
		});
		expect(mocks.listJoinRequests).not.toHaveBeenCalled();
	});

	it('gives an admin who linked the group the requests, the unconfirmed and the controls', async () => {
		mocks.groupView.mockResolvedValue(view({ linked: linked(ALL) }));
		const page = await load(request());
		expect(mocks.requireGroupWriter).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.listJoinRequests).toHaveBeenCalledWith(writer);
		expect(page).toMatchObject({
			manage: ALL,
			requests: REQUESTS,
			unconfirmed: [ROSTER.entries[1]],
			reapprove: false
		});
	});

	it('offers only what the link was granted: controls without admitting show no requests', async () => {
		mocks.groupView.mockResolvedValue(view({ linked: linked({ ...NONE, remove: true }) }));
		const page = await load(request());
		expect(page).toMatchObject({
			manage: { ...NONE, remove: true },
			requests: null,
			unconfirmed: []
		});
		expect(mocks.listJoinRequests).not.toHaveBeenCalled();
	});

	it('still shows the roster when the requests could not be listed', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mocks.groupView.mockResolvedValue(view({ linked: linked(ALL) }));
		mocks.listJoinRequests.mockRejectedValue(new Error('down'));
		expect(await load(request())).toMatchObject({ state: 'roster', requests: null });
	});

	it('offers to approve again a link approved before the members page asked for anything', async () => {
		mocks.groupView.mockResolvedValue(view({ linked: linked(NONE, true) }));
		expect(await load(request())).toMatchObject({ manage: NONE, reapprove: true });
	});

	it("shows the caller's own confirmation as the group was read for them, or has it read", async () => {
		for (const confirmed of [true, false, null]) {
			mocks.groupView.mockResolvedValue(view({ confirmed }));
			await load(request());
			expect(mocks.readRoster).toHaveBeenLastCalledWith(person, GROUP, confirmed);
		}
		// A sign-in that may not write it still has it read, never counted as written.
		mocks.callerSession.mockResolvedValue({ ...person, scope: 'atproto' });
		mocks.groupView.mockResolvedValue(view({ confirmed: null }));
		await load(request());
		expect(mocks.readRoster).toHaveBeenLastCalledWith(expect.anything(), GROUP, null);
	});

	it('tells someone not in the group, or signed out, that only members see it, and reads nothing', async () => {
		for (const [over, did] of [
			[{ member: false }, ALICE],
			[{ personal: null, member: null }, ALICE],
			[{ personal: null, member: null }, null]
		] as const) {
			mocks.groupView.mockResolvedValue(view(over));
			expect(await load(request('', did))).toMatchObject({
				state: 'hidden',
				message: 'Only members can see who is in this group.'
			});
		}
		expect(mocks.readRoster).not.toHaveBeenCalled();
	});

	it('says the same when the host does not let them read the members space', async () => {
		mocks.readRoster.mockRejectedValue(new SpaceAccessDenied('s', '400 NotAuthorized'));
		expect(await load(request())).toMatchObject({ state: 'hidden' });
	});

	it('says to try again when their membership or the roster could not be read', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.groupView.mockResolvedValue(view({ member: null }));
		await expect(load(request())).rejects.toMatchObject({ status: 503 });
		mocks.groupView.mockResolvedValue(view());
		mocks.readRoster.mockRejectedValue(new Error('down'));
		await expect(load(request())).rejects.toMatchObject({ status: 503 });
	});

	it('asks for the group permissions their own sign-in lacks, and names the spaces server once refused', async () => {
		Object.assign(env, { SPACES_PDS_URL: 'https://spaces.example' });
		mocks.groupView.mockResolvedValue(view({ askAccess: true, personal: null, member: null }));
		expect(await load(request())).toMatchObject({
			state: 'access',
			access: 'ask',
			spacesServer: null
		});
		expect(await load(request(`?asked=${ALICE}`))).toMatchObject({
			state: 'access',
			access: 'refused',
			spacesServer: { url: 'https://spaces.example/', host: 'spaces.example' }
		});
		expect(mocks.readRoster).not.toHaveBeenCalled();
		Reflect.deleteProperty(env, 'SPACES_PDS_URL');
	});

	it('is the same 404 as any group page when the group cannot be seen', async () => {
		mocks.groupView.mockRejectedValue(Object.assign(new Error('Group not found'), { status: 404 }));
		await expect(load(request())).rejects.toMatchObject({ status: 404 });
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ order: [] as string[], accept: vi.fn(), unaccept: vi.fn() }));
vi.mock('./acceptance', () => ({ accept: mocks.accept, unaccept: mocks.unaccept }));

import {
	admitMember,
	GroupActionError,
	leaveGroup,
	listJoinRequests,
	removeMember,
	requestJoin,
	setMemberRole
} from './host';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const MEMBERS = `at://${GROUP}/space/group.opensocial.members/self`;

type Answer = (pathname: string, init: RequestInit) => Response;

const session = (did: string, answer: Answer) => ({
	did,
	scope: '',
	handle: vi.fn(async (p: string, i: RequestInit) => answer(p, i))
});
const person = (answer: Answer) => session(ALICE, answer);
const admin = (answer: Answer) => session(GROUP, answer);

const body = (init: RequestInit) => JSON.parse(String(init.body));

beforeEach(() => {
	vi.resetAllMocks();
	mocks.order.length = 0;
	mocks.accept.mockImplementation(async () => mocks.order.push('accept'));
	mocks.unaccept.mockImplementation(async () => mocks.order.push('unaccept'));
});

describe("a person's own acts", () => {
	it("go to the group's PDS on their own session, and an admitted join confirms", async () => {
		const p = person(() => Response.json({ status: 'admitted' }));
		expect(await requestJoin(p, GROUP, 'hi')).toBe('joined');
		const [pathname, init] = p.handle.mock.calls[0];
		expect(pathname).toBe('/xrpc/group.opensocial.requestJoin');
		expect(init.headers).toMatchObject({ 'atproto-proxy': `${GROUP}#atproto_pds` });
		expect(body(init)).toEqual({ group: GROUP, message: 'hi' });
		expect(mocks.accept).toHaveBeenCalledWith(p, GROUP);
	});

	it('wait for an admin, writing no acceptance, when the group takes requests', async () => {
		const p = person(() => Response.json({ status: 'pending' }));
		expect(await requestJoin(p, GROUP, null)).toBe('pending');
		expect(mocks.accept).not.toHaveBeenCalled();
	});

	it('say so when the group is invite-only, in words of their own', async () => {
		const p = person(() =>
			Response.json({ error: 'JoinClosed', message: 'typed text' }, { status: 400 })
		);
		const thrown = await requestJoin(p, GROUP, null).catch((e) => e);
		expect(thrown).toBeInstanceOf(GroupActionError);
		expect(thrown.message).not.toContain('typed text');
	});

	it('take the acceptance back before leaving, while the host still lets them', async () => {
		const p = person(() => {
			mocks.order.push('leave');
			return Response.json({});
		});
		await leaveGroup(p, GROUP);
		expect(mocks.order).toEqual(['unaccept', 'leave']);
	});
});

describe("an admin's acts, as the group", () => {
	it('admit with a membership keyed by the member’s DID', async () => {
		const a = admin(() => Response.json({ uri: 'x', cid: 'y' }));
		await admitMember(a, ALICE, 'member');
		const [pathname, init] = a.handle.mock.calls[0];
		expect(pathname).toBe('/xrpc/com.atproto.space.createRecord');
		expect(body(init)).toMatchObject({
			space: MEMBERS,
			repo: GROUP,
			collection: 'group.opensocial.membership',
			rkey: ALICE,
			record: { $type: 'group.opensocial.membership', member: ALICE, roles: ['member'] }
		});
	});

	it('say an account is already a member rather than replace its roles', async () => {
		const a = admin(() => Response.json({ error: 'RecordAlreadyExists' }, { status: 400 }));
		await expect(admitMember(a, ALICE, 'member')).rejects.toThrow('already a member');
	});

	it('change a role in place, keeping its date and any role atmo does not know', async () => {
		const a = admin((pathname) =>
			pathname.includes('getRecord')
				? Response.json({
						value: {
							member: ALICE,
							roles: ['member', 'moderator'],
							createdAt: '2026-09-01T00:00:00Z'
						}
					})
				: Response.json({ uri: 'x', cid: 'y' })
		);
		await setMemberRole(a, ALICE, 'admin');
		const [pathname, init] = a.handle.mock.calls[1];
		expect(pathname).toBe('/xrpc/com.atproto.space.putRecord');
		expect(body(init).record).toMatchObject({
			roles: ['admin', 'moderator'],
			createdAt: '2026-09-01T00:00:00Z'
		});
	});

	it('refuse to change the role of someone who is not a member', async () => {
		const a = admin(() => Response.json({ error: 'RecordNotFound' }, { status: 400 }));
		await expect(setMemberRole(a, ALICE, 'admin')).rejects.toThrow('not a member');
	});

	it("pass on the host's refusal of their roles in plain words", async () => {
		const a = admin(() => Response.json({ error: 'Forbidden' }, { status: 403 }));
		await expect(removeMember(a, ALICE)).rejects.toThrow('Your roles in this group');
	});

	it('list the pending requests the host holds, every page', async () => {
		let page = 0;
		const a = admin(() =>
			Response.json(
				page++ === 0
					? {
							requests: [{ member: ALICE, createdAt: '2026-10-30T00:00:00Z', message: 'hi' }],
							cursor: 'c'
						}
					: { requests: [{ member: 'did:plc:bob', createdAt: '2026-10-30T01:00:00Z' }, {}] }
			)
		);
		expect((await listJoinRequests(a)).map((r) => [r.did, r.message])).toEqual([
			[ALICE, 'hi'],
			['did:plc:bob', null]
		]);
		expect(a.handle.mock.calls[1][0]).toContain('cursor=c');
	});
});

// The remote forms, run through their real handlers.
//
// `$app/server` is stubbed so `form()` hands back the handler itself and
// `getRequestEvent()` answers with this file's caller and bindings. Everything
// after that is real: the route gate (`groupRouteContext`), the standing read,
// the sessions lookup and the schema.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';

const request = vi.hoisted(() => ({
	locals: { did: null as string | null },
	platform: { env: {} as Record<string, unknown> }
}));

/** The handler, tagged the way SvelteKit's loader checks every export of a
 *  `*.remote.ts` (`init_remote_functions`). */
vi.mock('$app/server', () => {
	// The schema rides along, so a test can check what SvelteKit would validate
	// before the handler runs.
	const remote =
		(type: 'form' | 'command') =>
		(...args: unknown[]) =>
			Object.assign(args.at(-1) as object, {
				__: { type },
				schema: args.length > 1 ? args[0] : undefined
			});
	return { form: remote('form'), command: remote('command'), getRequestEvent: () => request };
});
// The people search reaches $lib/contrail, whose one runtime import from the UI
// package would pull in plyr's CSS, which Node's ESM loader rejects. Same
// pattern as ../search/server/query.test.ts.
vi.mock('@atmo-dev/events-ui', () => ({ getProfileUrl: vi.fn() }));
// A linked group's session, so the group's own writes reach the fake host. The
// sign-in client's authorize is a stand-in too, so a re-authorization can be
// accepted or refused without a PDS.
const signIn = vi.hoisted(() => ({
	authorize: null as null | ((grants: readonly string[]) => Promise<{ url: URL }>)
}));
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./server/__fixtures__/linked-oauth-stub')).linkedOAuthStub,
	createOAuthClient: (_env: unknown, grants: readonly string[] = []) => ({
		authorize: async () => {
			if (!signIn.authorize) throw new Error('no sign-in stand-in for this test');
			return signIn.authorize(grants);
		}
	})
}));

import { sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { stubPds } from './server/__fixtures__/stub-pds';
import { linkGroups, linkedCredential, unlinkAllGroups } from './server/__fixtures__/linked-group';
import { createGroup, recordGroupSpaces } from './server/repo';
import { GroupCredentialError } from './server/event-writer';
import { acceptanceGrant } from './server/member-grants';
import { RSVP_NO_SPACES, RSVP_RETRY_LATER } from './server/member-rsvp';
import { OAuthResponseError } from '@atcute/oauth-node-client';
import { addMember } from './server/repo';
import { pdsProvisioner, provisionGroupSpaces } from './server/spaces';
import { formError } from './form-error';
import type { GroupFormResult } from './form-result';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from './types';
import {
	cancelMembersOnlyRsvp,
	joinGroupForm,
	leaveGroupForm,
	putGroupEvent,
	removeGroupEvent,
	rsvpToMembersOnlyEvent,
	updateGroupForm
} from './groups.remote';

const OWNER = 'did:plc:owner';
const GROUP_DID = 'did:plc:unlinkedgroupaaaaaaaaaaa';

/** The handler `form()` was given, which is what the stub returned. */
const submitUpdate = updateGroupForm as unknown as (
	data: Record<string, unknown>
) => Promise<GroupFormResult>;

/** The handlers `form()` was given for the join and leave buttons. */
const submitJoin = joinGroupForm as unknown as (
	data: Record<string, unknown>
) => Promise<GroupFormResult>;
const submitLeave = leaveGroupForm as unknown as (
	data: Record<string, unknown>
) => Promise<GroupFormResult>;

let harness: SqliteD1;

beforeEach(() => {
	harness = sqliteD1();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	unlinkAllGroups();
	harness.close();
	request.locals = { did: null };
	signIn.authorize = null;
});

describe('a group whose owner has not linked it', () => {
	// Its members space cannot be read without the link, so nobody's
	// permissions are known. "Not allowed" would send the owner looking for a
	// role they already hold; the way out is the link, which only they can do.
	it('tells its owner to link the group when they save its settings', async () => {
		const row = await createGroup(harness.db, {
			groupDid: GROUP_DID,
			ownerDid: OWNER,
			name: 'Kona Trail Runners'
		});
		await recordGroupSpaces(harness.db, row.id, {
			aboutSpaceUri: `at://${GROUP_DID}/space/${ABOUT_SPACE_TYPE}/self`,
			membersSpaceUri: `at://${GROUP_DID}/space/${MEMBERS_SPACE_TYPE}/self`
		});
		request.locals.did = OWNER;
		request.platform.env = { DB: harness.db, ...linkGroups([]) };

		const result = await submitUpdate({
			groupDid: GROUP_DID,
			name: 'Kona Trail Runners',
			visibility: 'public',
			shownVisibility: 'public',
			requireApproval: true
		});

		expect(result).toEqual(formError(new GroupCredentialError(GROUP_DID)));
	});
});

// The caller's session is what writes their acceptance, so the forms have to
// hand it to the roster. The group's side runs against the fake host; the
// member's PDS is a session that records what it was asked.
describe('the join and leave buttons, for a member whose session holds the grant', () => {
	const LINKED = 'did:plc:linkedgroupaaaaaaaaaaaaa';
	const JOINER = 'did:plc:joineraaaaaaaaaaaaaaaaaa';

	it('a request writes the requester’s acceptance, and withdrawing it deletes it', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		stubPds({ did: LINKED, handle: 'linked.group.stub.test' });
		const row = await createGroup(harness.db, {
			groupDid: LINKED,
			ownerDid: OWNER,
			name: 'Linked'
		});
		const uris = await provisionGroupSpaces(
			pdsProvisioner(linkedCredential(LINKED), LINKED),
			'public'
		);
		await recordGroupSpaces(harness.db, row.id, uris);
		const asked: { nsid: string; space: unknown; repo: unknown }[] = [];
		const session = {
			did: JOINER,
			getTokenInfo: async () => ({ scope: `atproto ${acceptanceGrant(LINKED)}` }),
			handle: async (pathname: string, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as Record<string, unknown>;
				asked.push({ nsid: pathname, space: body.space, repo: body.repo });
				return Response.json({ uri: 'at://x', cid: 'bafy' });
			}
		};
		request.locals = { did: JOINER, session } as typeof request.locals;
		request.platform.env = { DB: harness.db, ...linkGroups([LINKED]) };

		expect(await submitJoin({ groupDid: LINKED })).toMatchObject({ ok: true, outcome: 'pending' });
		expect(await submitLeave({ groupDid: LINKED })).toMatchObject({
			ok: true,
			outcome: 'withdrawn'
		});

		expect(asked).toEqual([
			{
				nsid: '/xrpc/com.atproto.space.createRecord',
				space: uris.membersSpaceUri,
				repo: JOINER
			},
			{
				nsid: '/xrpc/com.atproto.space.deleteRecord',
				space: uris.membersSpaceUri,
				repo: JOINER
			}
		]);
	});
});

// Where the editor's commands may write an event. The page never chooses the
// space: the only one a command takes is the group's own calendar space, and
// every refusal comes back as a message the editor shows, not a thrown 500.
describe('placement on the event commands', () => {
	const LINKED = 'did:plc:linkedgroupaaaaaaaaaaaaa';
	/** Written out, not taken from the app. */
	const CALENDAR = `at://${LINKED}/space/net.openmeet.space.calendar/self`;
	const EVENT = 'community.lexicon.calendar.event';

	const NO_PLACEMENT =
		'This event was sent without saying whether it is public or members-only, so nothing was saved.';
	const NOT_THE_CALENDAR_SPACE =
		"A members-only event can only go in this group's calendar space, so nothing was saved.";
	const NO_CALENDAR_SPACE =
		'This group has no calendar space for members-only events, because it was made before they existed. Re-create the group to post members-only events. Nothing was saved.';
	const READABLE_CALENDAR_SPACE =
		"This group's calendar space can be read by more than its members, so the members-only event was not saved.";
	const UNCHECKED_CALENDAR_SPACE =
		"The group's calendar space could not be checked, so the members-only event was not saved. Try again later.";
	const PLACEMENT_CHANGE =
		"This event can't be moved between public and members-only yet. Nothing was saved.";
	const WRONG_PLACEMENT_DELETE =
		"This event wasn't deleted, because the page had it as public when it's members-only, or the other way round. Reload and try again.";
	const UNCHECKED_PLACEMENT =
		'Whether this event is public or members-only could not be checked, so nothing was saved. Try again later.';

	type EventResult = GroupFormResult<{ uri: string }>;
	const put = putGroupEvent as unknown as (data: Record<string, unknown>) => Promise<EventResult>;
	const remove = removeGroupEvent as unknown as (
		data: Record<string, unknown>
	) => Promise<EventResult>;

	let pds: ReturnType<typeof stubPds>;
	let uris: Awaited<ReturnType<typeof provisionGroupSpaces>>;
	/** The method the host fails with a 500, when a case sets one. */
	let failing: string | null;

	const event = (name = 'Linked meetup') => ({
		name,
		createdAt: '2026-09-01T12:00:00.000Z',
		startsAt: '2026-09-20T18:00:00.000Z',
		mode: 'community.lexicon.calendar.event#inperson',
		status: 'community.lexicon.calendar.event#scheduled'
	});

	/** Puts an event on the host directly, with no app code: in the calendar
	 *  space, or in the public repo for null. */
	async function seed(space: string | null, rkey: string) {
		const method = space ? 'com.atproto.space.putRecord' : 'com.atproto.repo.putRecord';
		await fetch(`https://pds.stub.test/xrpc/${method}`, {
			method: 'POST',
			body: JSON.stringify({
				...(space ? { space } : {}),
				repo: LINKED,
				collection: EVENT,
				rkey,
				record: { $type: EVENT, ...event() }
			})
		});
	}

	beforeEach(async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		failing = null;
		pds = stubPds({
			did: LINKED,
			handle: 'linked.group.stub.test',
			fail: (nsid) =>
				nsid === failing
					? Response.json({ error: 'InternalServerError' }, { status: 500 })
					: undefined
		});
		const row = await createGroup(harness.db, {
			groupDid: LINKED,
			ownerDid: OWNER,
			name: 'Linked'
		});
		uris = await provisionGroupSpaces(pdsProvisioner(linkedCredential(LINKED), LINKED), 'public');
		await recordGroupSpaces(harness.db, row.id, uris);
		request.locals.did = OWNER;
		request.platform.env = { DB: harness.db, ...linkGroups([LINKED]) };
		pds.clearLog();
	});

	it('the event commands take a placement that is null or a string, never left out', () => {
		const schemaOf = (command: unknown) =>
			(command as { schema: v.GenericSchema<unknown, unknown> }).schema;
		const valid = (command: unknown, data: Record<string, unknown>) =>
			v.safeParse(schemaOf(command), data).success;

		const putting = { groupDid: LINKED, rkey: '3abc', intent: 'create', record: event() };
		expect(valid(putGroupEvent, { ...putting, space: null })).toBe(true);
		expect(valid(putGroupEvent, { ...putting, space: CALENDAR })).toBe(true);
		expect(valid(putGroupEvent, putting)).toBe(false);
		expect(valid(putGroupEvent, { ...putting, space: undefined })).toBe(false);

		const removing = { groupDid: LINKED, rkey: '3abc' };
		expect(valid(removeGroupEvent, { ...removing, space: null })).toBe(true);
		expect(valid(removeGroupEvent, { ...removing, space: CALENDAR })).toBe(true);
		expect(valid(removeGroupEvent, removing)).toBe(false);
		expect(valid(removeGroupEvent, { ...removing, space: undefined })).toBe(false);
	});

	it("a space other than the group's calendar space is refused before any PDS call", async () => {
		const others = [
			uris.aboutSpaceUri,
			uris.membersSpaceUri,
			`at://${LINKED}/space/net.openmeet.space.calendar/other`,
			'at://did:plc:anothergroupaaaaaaaaaaaa/space/net.openmeet.space.calendar/self'
		];
		for (const space of others) {
			const putting = { groupDid: LINKED, rkey: '3abc', space, record: event() };
			for (const intent of ['create', 'update']) {
				expect(await put({ ...putting, intent })).toEqual({
					ok: false,
					error: NOT_THE_CALENDAR_SPACE
				});
			}
			expect(await remove({ groupDid: LINKED, rkey: '3abc', space })).toEqual({
				ok: false,
				error: NOT_THE_CALENDAR_SPACE
			});
		}
		// Not even the caller's standing was read.
		expect(pds.calls).toEqual([]);

		// The group's own calendar space does reach the host, so the silence above
		// is the refusal.
		expect(
			await put({
				groupDid: LINKED,
				rkey: '3abc',
				intent: 'create',
				space: CALENDAR,
				record: event()
			})
		).toMatchObject({ ok: true });
		expect(pds.spaceWrites.map((w) => w.space)).toEqual([CALENDAR]);
	});

	it('a command with no placement is refused before any PDS call, even past the schema', async () => {
		expect(
			await put({ groupDid: LINKED, rkey: '3abc', intent: 'create', record: event() })
		).toEqual({ ok: false, error: NO_PLACEMENT });
		expect(await remove({ groupDid: LINKED, rkey: '3abc' })).toEqual({
			ok: false,
			error: NO_PLACEMENT
		});
		expect(pds.calls).toEqual([]);
	});

	it('each placement refusal reaches the form as a message, not a 500', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await seed(null, '3public');
		await seed(CALENDAR, '3members');
		pds.clearLog();
		const putting = (rkey: string, intent: string, space: unknown) =>
			put({ groupDid: LINKED, rkey, intent, space, record: event('Linked meetup, edited') });
		const calendar = pds.spaces.get(CALENDAR)!;

		const cases: [string, () => void, () => Promise<EventResult>, string][] = [
			['no placement', () => {}, () => putting('3new', 'create', undefined), NO_PLACEMENT],
			[
				'another space',
				() => {},
				() => putting('3new', 'create', uris.aboutSpaceUri),
				NOT_THE_CALENDAR_SPACE
			],
			['a flip to public', () => {}, () => putting('3members', 'update', null), PLACEMENT_CHANGE],
			[
				'a flip to members-only',
				() => {},
				() => putting('3public', 'update', CALENDAR),
				PLACEMENT_CHANGE
			],
			[
				'a public delete of a members-only event',
				() => {},
				() => remove({ groupDid: LINKED, rkey: '3members', space: null }),
				WRONG_PLACEMENT_DELETE
			],
			[
				'a members-only delete of a public event',
				() => {},
				() => remove({ groupDid: LINKED, rkey: '3public', space: CALENDAR }),
				WRONG_PLACEMENT_DELETE
			],
			[
				'a placement read that failed',
				() => {
					failing = 'com.atproto.repo.getRecord';
				},
				() => putting('3public', 'update', null),
				UNCHECKED_PLACEMENT
			],
			[
				'no calendar space',
				() => {
					pds.spaces.delete(CALENDAR);
				},
				() => putting('3new', 'create', CALENDAR),
				NO_CALENDAR_SPACE
			],
			[
				'a calendar space anyone may read',
				() => {
					pds.spaces.set(CALENDAR, {
						...calendar,
						readPolicy: { $type: 'com.atproto.simplespace.defs#publicPolicy' }
					});
				},
				() => putting('3new', 'create', CALENDAR),
				READABLE_CALENDAR_SPACE
			],
			[
				'a calendar space that could not be checked',
				() => {
					failing = 'com.atproto.simplespace.getSpace';
				},
				() => putting('3new', 'create', CALENDAR),
				UNCHECKED_CALENDAR_SPACE
			]
		];

		for (const [, arrange, run, error] of cases) {
			failing = null;
			pds.spaces.set(CALENDAR, calendar);
			arrange();
			// Resolving at all is the point: a throw here would be the 500.
			await expect(run()).resolves.toEqual({ ok: false, error });
		}
		expect(pds.writes()).toEqual([]);
	});
});

// The two members-only RSVP commands, run through their real handlers: the
// route gate, the standing read and the grant check are the app's own. The
// group's host is the fake one; the member's PDS is a session that records what
// it was asked. (Spec: FR-113, FR-114, FR-120.)
describe('the members-only RSVP commands', () => {
	const LINKED = 'did:plc:linkedgroupaaaaaaaaaaaaa';
	const MEMBER = 'did:plc:rsvpmemberaaaaaaaaaaaaaa';
	/** Written out, not taken from the app. */
	const CALENDAR = `at://${LINKED}/space/net.openmeet.space.calendar/self`;
	const RSVP = 'community.lexicon.calendar.rsvp';
	const MEETING_URI = `${CALENDAR}/${LINKED}/community.lexicon.calendar.event/3lmeeting`;
	/** What a sign-in granted before RSVPs joined the grant, written out. */
	const ACCEPTANCE_ONLY = `atproto space:*?authority=${LINKED}&collection=group.opensocial.acceptance&action=create&action=update&action=delete`;

	type RsvpResult = { ok: boolean; reason?: string; message?: string; url?: string; uri?: string };
	const rsvp = rsvpToMembersOnlyEvent as unknown as (
		data: Record<string, unknown>
	) => Promise<RsvpResult>;
	const cancel = cancelMembersOnlyRsvp as unknown as (
		data: Record<string, unknown>
	) => Promise<RsvpResult>;
	const schemaOf = (command: unknown) =>
		(command as { schema: v.GenericSchema<unknown, Record<string, unknown>> }).schema;

	let asked: { pathname: string; body: Record<string, unknown> | null }[];
	let uris: Awaited<ReturnType<typeof provisionGroupSpaces>>;

	function signInAs(scope: string) {
		const session = {
			did: MEMBER,
			getTokenInfo: async () => ({ scope }),
			handle: async (pathname: string, init: RequestInit) => {
				const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
				asked.push({ pathname, body });
				return Response.json({ uri: `${CALENDAR}/${MEMBER}/${RSVP}/3lmeeting`, cid: 'bafy' });
			}
		};
		request.locals = { did: MEMBER, session } as typeof request.locals;
	}

	beforeEach(async () => {
		asked = [];
		stubPds({ did: LINKED, handle: 'linked.group.stub.test' });
		const row = await createGroup(harness.db, {
			groupDid: LINKED,
			ownerDid: OWNER,
			name: 'Linked'
		});
		uris = await provisionGroupSpaces(pdsProvisioner(linkedCredential(LINKED), LINKED), 'public');
		await recordGroupSpaces(harness.db, row.id, uris);
		await addMember(harness.db, row.id, MEMBER, 'member');
		// A deployment that serves client metadata, so a re-authorization is asked for.
		request.platform.env = {
			DB: harness.db,
			OAUTH_PUBLIC_URL: 'https://atmo.stub.test',
			...linkGroups([LINKED])
		};
	});

	it("a members-only RSVP names the event's space-form URI, whatever the browser sent", async () => {
		signInAs(`atproto ${acceptanceGrant(LINKED)}`);
		// What a page could add beside the four inputs: none of it is read.
		const forged = {
			space: uris.membersSpaceUri,
			spaceUri: uris.aboutSpaceUri,
			collection: 'app.bsky.feed.post',
			repo: 'did:plc:someoneelseaaaaaaaaaaaa',
			subject: { uri: `at://${LINKED}/community.lexicon.calendar.event/3lmeeting` },
			record: { $type: RSVP, subject: { uri: 'at://did:plc:elsewhere/x/y' } },
			uri: 'at://did:plc:elsewhere/x/y'
		};
		const sent = { groupDid: LINKED, rkey: '3lmeeting', status: 'going', asked: false };

		expect(await rsvp({ ...sent, ...forged })).toEqual({
			ok: true,
			uri: `${CALENDAR}/${MEMBER}/${RSVP}/3lmeeting`
		});
		expect(await cancel({ groupDid: LINKED, rkey: '3lmeeting', asked: false, ...forged })).toEqual({
			ok: true
		});

		expect(asked).toEqual([
			{
				pathname: '/xrpc/com.atproto.space.putRecord',
				body: {
					space: CALENDAR,
					repo: MEMBER,
					collection: RSVP,
					rkey: '3lmeeting',
					record: {
						$type: RSVP,
						status: `${RSVP}#going`,
						subject: { uri: MEETING_URI },
						createdAt: expect.any(String)
					}
				}
			},
			{
				pathname: '/xrpc/com.atproto.space.deleteRecord',
				body: { space: CALENDAR, repo: MEMBER, collection: RSVP, rkey: '3lmeeting' }
			}
		]);
		// And what SvelteKit validates keeps only the inputs: no space, collection,
		// record or subject reaches the handler from a real request either.
		expect(
			Object.keys(v.parse(schemaOf(rsvpToMembersOnlyEvent), { ...sent, ...forged })).sort()
		).toEqual(['asked', 'groupDid', 'rkey', 'status']);
		expect(
			Object.keys(
				v.parse(schemaOf(cancelMembersOnlyRsvp), {
					groupDid: LINKED,
					rkey: '3lmeeting',
					asked: false,
					...forged
				})
			).sort()
		).toEqual(['asked', 'groupDid', 'rkey']);
		// A status the lexicon does not name is refused before the handler.
		expect(
			v.safeParse(schemaOf(rsvpToMembersOnlyEvent), { ...sent, status: 'maybe' }).success
		).toBe(false);
	});

	it('a re-authorization refused as invalid_scope says to try again shortly, never the no-spaces message', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		signInAs(ACCEPTANCE_ONLY);
		const tried: string[][] = [];
		// A PDS still serving client metadata without the widened grant refuses
		// every set that carries it.
		signIn.authorize = async (grants) => {
			tried.push([...grants]);
			throw new OAuthResponseError(
				new Response(null, { status: 400 }),
				'invalid_scope',
				`Scope "${acceptanceGrant(LINKED)}" is not declared in the client metadata`
			);
		};

		const put = await rsvp({ groupDid: LINKED, rkey: '3lmeeting', status: 'going', asked: false });
		const del = await cancel({ groupDid: LINKED, rkey: '3lmeeting', asked: false });

		for (const result of [put, del]) {
			expect(result).toEqual({ ok: false, reason: 'retry-later', message: RSVP_RETRY_LATER });
			expect(result.message).not.toBe(RSVP_NO_SPACES);
		}
		// Each attempt asked for this group's grant, and none was retried in a loop:
		// one authorize per set that carries it, per press.
		expect(tried.length).toBe(2);
		for (const grants of tried) expect(grants).toContain(acceptanceGrant(LINKED));
		// Nothing reached the member's PDS.
		expect(asked).toEqual([]);

		// The same press with a PDS that accepts the grant is sent to consent.
		signIn.authorize = async () => ({
			url: new URL('https://pds.stub.test/oauth/authorize?request_uri=urn:x')
		});
		expect(
			await rsvp({ groupDid: LINKED, rkey: '3lmeeting', status: 'going', asked: false })
		).toEqual({
			ok: false,
			reason: 'reauthorize',
			url: 'https://pds.stub.test/oauth/authorize?request_uri=urn:x'
		});
		expect(asked).toEqual([]);
	});
});

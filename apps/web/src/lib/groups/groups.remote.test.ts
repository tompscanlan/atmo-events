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
import { createGroup, recordGroupSpaces, addMember } from './server/repo';

import { acceptanceGrant } from './server/member-grants';
import { RSVP_NO_SPACES, RSVP_RETRY_LATER } from './server/member-rsvp';
import { OAuthResponseError } from '@atcute/oauth-node-client';
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

import { GroupCredentialError } from './server/session';
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
// route gate, the standing read, the grant check and the event read as the
// group are the app's own. The group's host is the fake one; the member's PDS
// is a session that records what it was asked. (Spec: FR-113, FR-114, FR-120.)
describe('the members-only RSVP commands', () => {
	const LINKED = 'did:plc:linkedgroupaaaaaaaaaaaaa';
	const MEMBER = 'did:plc:rsvpmemberaaaaaaaaaaaaaa';
	const OTHER = 'did:plc:rsvpotheraaaaaaaaaaaaaaa';
	/** Written out, not taken from the app. */
	const CALENDAR = `at://${LINKED}/space/net.openmeet.space.calendar/self`;
	const RSVP = 'community.lexicon.calendar.rsvp';
	const EVENT = 'community.lexicon.calendar.event';
	const MEETING_URI = `${CALENDAR}/${LINKED}/${EVENT}/3lmeeting`;
	/** The cid the fake host gives every record it holds. */
	const MEETING_CID = 'bafycreate';
	/** What a sign-in granted before RSVPs joined the grant, written out. */
	const ACCEPTANCE_ONLY = `atproto space:*?authority=${LINKED}&collection=group.opensocial.acceptance&action=create&action=update&action=delete`;
	/** When the member's token expires, before a re-authorization and after it. */
	const SESSION = Date.parse('2026-10-08T14:00:00.000Z');
	const NEXT_SESSION = Date.parse('2026-10-08T15:00:00.000Z');
	const CONSENT = 'https://pds.stub.test/oauth/authorize?request_uri=urn:x';

	type RsvpResult = {
		ok: boolean;
		reason?: string;
		message?: string;
		url?: string;
		uri?: string;
		marker?: string;
	};
	const rsvp = rsvpToMembersOnlyEvent as unknown as (
		data: Record<string, unknown>
	) => Promise<RsvpResult>;
	const cancel = cancelMembersOnlyRsvp as unknown as (
		data: Record<string, unknown>
	) => Promise<RsvpResult>;
	const schemaOf = (command: unknown) =>
		(command as { schema: v.GenericSchema<unknown, Record<string, unknown>> }).schema;

	let asked: { pathname: string; body: Record<string, unknown> | null }[];
	/** Every token read the commands made, by its refresh argument. */
	let tokenReads: unknown[];
	let uris: Awaited<ReturnType<typeof provisionGroupSpaces>>;

	/** Signs `did` in with a session granted `scope`, whose token expires at
	 *  `expiresAt` (none when absent). */
	function signInAs(
		scope: string,
		{ did = MEMBER, expiresAt }: { did?: string; expiresAt?: number } = {}
	) {
		const session = {
			did,
			getTokenInfo: async (refresh?: unknown) => {
				tokenReads.push(refresh);
				return { scope, ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt) }) };
			},
			handle: async (pathname: string, init: RequestInit) => {
				const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
				asked.push({ pathname, body });
				return Response.json({ uri: `${CALENDAR}/${did}/${RSVP}/3lmeeting`, cid: 'bafy' });
			}
		};
		request.locals = { did, session } as typeof request.locals;
	}

	/** Writes the meeting into the calendar space, as the group's host holds it. */
	async function seedMeeting() {
		const res = await fetch('https://linked.group.stub.test/xrpc/com.atproto.space.putRecord', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				space: CALENDAR,
				repo: LINKED,
				collection: EVENT,
				rkey: '3lmeeting',
				record: { $type: EVENT, name: 'Committee call', startsAt: '2030-11-02T18:00:00.000Z' }
			})
		});
		expect(res.ok).toBe(true);
	}

	beforeEach(async () => {
		asked = [];
		tokenReads = [];
		stubPds({ did: LINKED, handle: 'linked.group.stub.test' });
		const row = await createGroup(harness.db, {
			groupDid: LINKED,
			ownerDid: OWNER,
			name: 'Linked'
		});
		uris = await provisionGroupSpaces(pdsProvisioner(linkedCredential(LINKED), LINKED), 'public');
		await recordGroupSpaces(harness.db, row.id, uris);
		await addMember(harness.db, row.id, MEMBER, 'member');
		await addMember(harness.db, row.id, OTHER, 'member');
		await seedMeeting();
		// A deployment that serves client metadata, so a re-authorization is asked for.
		request.platform.env = {
			DB: harness.db,
			OAUTH_PUBLIC_URL: 'https://atmo.stub.test',
			...linkGroups([LINKED])
		};
	});

	it("a members-only RSVP names the event's space-form URI, whatever the browser sent", async () => {
		signInAs(`atproto ${acceptanceGrant(LINKED)}`);
		// What a page could add beside the five inputs: none of it is read.
		const forged = {
			space: uris.membersSpaceUri,
			spaceUri: uris.aboutSpaceUri,
			collection: 'app.bsky.feed.post',
			repo: 'did:plc:someoneelseaaaaaaaaaaaa',
			subject: { uri: `at://${LINKED}/community.lexicon.calendar.event/3lmeeting` },
			record: { $type: RSVP, subject: { uri: 'at://did:plc:elsewhere/x/y' } },
			uri: 'at://did:plc:elsewhere/x/y'
		};
		const sent = {
			groupDid: LINKED,
			rkey: '3lmeeting',
			status: 'going',
			cid: MEETING_CID,
			asked: null
		};

		expect(await rsvp({ ...sent, ...forged })).toEqual({
			ok: true,
			uri: `${CALENDAR}/${MEMBER}/${RSVP}/3lmeeting`
		});
		expect(await cancel({ groupDid: LINKED, rkey: '3lmeeting', asked: null, ...forged })).toEqual({
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
						subject: { uri: MEETING_URI, cid: MEETING_CID },
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
		).toEqual(['asked', 'cid', 'groupDid', 'rkey', 'status']);
		expect(
			Object.keys(
				v.parse(schemaOf(cancelMembersOnlyRsvp), {
					groupDid: LINKED,
					rkey: '3lmeeting',
					asked: null,
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
		const press = { groupDid: LINKED, rkey: '3lmeeting', asked: null };

		const put = await rsvp({ ...press, status: 'going', cid: MEETING_CID });
		const del = await cancel(press);

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
		signIn.authorize = async () => ({ url: new URL(CONSENT) });
		expect(await rsvp({ ...press, status: 'going', cid: MEETING_CID })).toEqual({
			ok: false,
			reason: 'reauthorize',
			url: CONSENT,
			marker: expect.any(String)
		});
		expect(asked).toEqual([]);
	});

	// The page carries a marker through consent and back, so the server can tell
	// a member who went through a re-authorization that asked for the grant from
	// one who has not yet. It counts only for the member it was made for, and
	// only once a new session has been issued since, so a link someone shared,
	// or Back from the consent screen, is sent through re-authorization again
	// rather than told their PDS can't do this. (Spec: FR-114.)
	it('an asked marker naming another member, or the session it was issued under, re-authorizes instead of the no-spaces message', async () => {
		let consents = 0;
		signIn.authorize = async () => {
			consents++;
			return { url: new URL(CONSENT) };
		};
		const press = { groupDid: LINKED, rkey: '3lmeeting' };
		const going = { ...press, status: 'going', cid: MEETING_CID };

		// The first press, from a session that predates the grant.
		signInAs(ACCEPTANCE_ONLY, { expiresAt: SESSION });
		const first = await rsvp({ ...going, asked: null });
		expect(first).toEqual({
			ok: false,
			reason: 'reauthorize',
			url: CONSENT,
			marker: expect.any(String)
		});
		const marker = first.marker!;
		expect(marker.length).toBeGreaterThan(0);

		// Back from the consent screen without signing in: the same session, so
		// both buttons re-authorize again, with the same marker.
		for (const result of [
			await rsvp({ ...going, asked: marker }),
			await cancel({ ...press, asked: marker })
		]) {
			expect(result).toEqual({ ok: false, reason: 'reauthorize', url: CONSENT, marker });
		}

		// Another member opens the link the first one shared, from a session of
		// their own that also predates the grant.
		signInAs(ACCEPTANCE_ONLY, { did: OTHER, expiresAt: NEXT_SESSION });
		const shared = await rsvp({ ...going, asked: marker });
		expect(shared).toEqual({
			ok: false,
			reason: 'reauthorize',
			url: CONSENT,
			marker: expect.any(String)
		});
		expect(shared.marker).not.toBe(marker);

		// A marker that is not one the server made counts as none.
		signInAs(ACCEPTANCE_ONLY, { expiresAt: NEXT_SESSION });
		for (const malformed of ['asked', `${marker}0x`, marker.toUpperCase(), '']) {
			expect(await rsvp({ ...going, asked: malformed })).toEqual({
				ok: false,
				reason: 'reauthorize',
				url: CONSENT,
				marker: expect.any(String)
			});
		}

		// Only the member it was made for, under a session issued since, is told
		// their PDS can't do it, and is not sent through consent again.
		const before = consents;
		expect(await rsvp({ ...going, asked: marker })).toEqual({
			ok: false,
			reason: 'no-spaces',
			message: RSVP_NO_SPACES
		});
		expect(await cancel({ ...press, asked: marker })).toEqual({
			ok: false,
			reason: 'no-spaces',
			message: RSVP_NO_SPACES
		});
		expect(consents).toBe(before);
		// One consent per press that re-authorized, nothing sent from a member's
		// session, and the session's stamp read without a token refresh.
		expect(consents).toBe(1 + 2 + 1 + 4);
		expect(asked).toEqual([]);
		expect(tokenReads.length).toBeGreaterThan(0);
		expect(tokenReads.every((refresh) => refresh === false)).toBe(true);
	});

	it('an asked marker with no member session says to try again, never the no-spaces message', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		let consents = 0;
		signIn.authorize = async () => {
			consents++;
			return { url: new URL(CONSENT) };
		};
		const press = { groupDid: LINKED, rkey: '3lmeeting' };
		const going = { ...press, status: 'going', cid: MEETING_CID };
		signInAs(ACCEPTANCE_ONLY, { expiresAt: SESSION });
		const { marker } = await rsvp({ ...going, asked: null });
		expect(marker).toEqual(expect.any(String));

		// Back from consent, but the session can't be read just now, or there is
		// no session object at all: what the session holds is unknown, so the
		// member is told to try again, not that their PDS can't do it.
		const unreadable = {
			did: MEMBER,
			getTokenInfo: async () => {
				throw new Error('the session store did not answer');
			},
			handle: async () => {
				throw new Error('nothing may be sent without a session');
			}
		};
		for (const session of [unreadable, null]) {
			request.locals = { did: MEMBER, session } as unknown as typeof request.locals;
			for (const result of [
				await rsvp({ ...going, asked: marker }),
				await cancel({ ...press, asked: marker })
			]) {
				expect(result).toEqual({ ok: false, reason: 'retry-later', message: RSVP_RETRY_LATER });
				expect(result.message).not.toBe(RSVP_NO_SPACES);
			}
		}
		// Only the first press went through consent, and nothing was sent.
		expect(consents).toBe(1);
		expect(asked).toEqual([]);
	});
});

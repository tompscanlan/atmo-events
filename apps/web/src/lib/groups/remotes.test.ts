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

import { memberGrant } from './server/member-grants';
import { RSVP_NO_SPACES, RSVP_RETRY_LATER } from './server/member-rsvp';
import { pdsProvisioner, provisionGroupSpaces } from './server/spaces';
import { GroupPlacementError } from './server/event-writer';
import { formError, notAllowed } from './form-error';
import type { GroupFormResult } from './form-result';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from './types';

import { GroupCredentialError } from './server/session';
import { createGroup, getGroupByDid, recordGroupSpaces } from './server/db/groups';
import { seedGroup } from './server/__fixtures__/seed-group';
import { spaceReader } from './server/__fixtures__/space-reader';
import { fixtureSessions, resetReaderHost, serveReader } from './server/__fixtures__/reader-host';
import { addMember } from './server/db/roster';
import { updateGroupForm } from './group.remote';
import { joinGroupForm, leaveGroupForm } from './roster.remote';
import { putGroupEvent, removeGroupEvent } from './group-events.remote';
import { cancelMembersOnlyRsvp, rsvpToMembersOnlyEvent } from './member-rsvp.remote';
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

// Every group form resolves its context through the same gate. A signed-out
// caller is refused with a 401 before the group is looked up, so no session is
// built and nothing is read. A member without MANAGE_GROUP gets "Not allowed"
// from the settings save, for a rename and for a visibility flip alike, and the
// group's PDS is asked nothing but the gate's reads. The group is public and
// linked, and its members space holds no records, so the rows decide standing.
describe('the gate in front of the group forms', () => {
	const LINKED = 'did:plc:linkedgroupaaaaaaaaaaaaa';
	const MEMBER = 'did:plc:memberaaaaaaaaaaaaaaaaaa';
	const NAME = 'Kona Trail Runners';
	const PUBLIC = 'com.atproto.simplespace.defs#publicPolicy';
	const READS = [
		'/xrpc/com.atproto.space.getRecord',
		'/xrpc/com.atproto.space.listRecords',
		'/xrpc/com.atproto.simplespace.getSpace'
	];

	beforeEach(async () => {
		const { spaces } = await seedGroup({
			harness,
			groupDid: LINKED,
			ownerDid: OWNER,
			name: NAME,
			members: { [MEMBER]: 'member' }
		});
		serveReader(LINKED, spaceReader(LINKED, { policies: { [spaces.aboutSpaceUri]: PUBLIC } }));
		request.platform.env = { DB: harness.db, OAUTH_SESSIONS: fixtureSessions };
	});

	afterEach(() => resetReaderHost());

	/** The paths of every request made to the group's PDS. */
	function asked(): string[] {
		return vi
			.mocked(fetch)
			.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)))
			.map((url) => url.pathname);
	}

	it.each([
		[
			'saving the settings',
			() =>
				submitUpdate({
					groupDid: LINKED,
					name: 'Renamed',
					visibility: 'public',
					shownVisibility: 'public',
					requireApproval: true
				})
		],
		['asking to join', () => submitJoin({ groupDid: LINKED })]
	])('refuses a signed-out caller %s with a 401, before any read', async (_, submit) => {
		request.locals.did = null;

		await expect(submit()).rejects.toMatchObject({ status: 401 });
		expect(fixtureSessions.reads).toBe(0);
		expect(asked()).toEqual([]);
	});

	it.each([
		['renaming the group', { name: 'Renamed', visibility: 'public' }],
		['making the group private', { name: NAME, visibility: 'private' }]
	])('refuses a member without MANAGE_GROUP %s, and writes nothing', async (_, change) => {
		request.locals.did = MEMBER;

		const result = await submitUpdate({
			groupDid: LINKED,
			...change,
			shownVisibility: 'public',
			requireApproval: true
		});

		expect(result).toEqual(notAllowed({}, 'MANAGE_GROUP'));
		expect(asked().filter((path) => !READS.includes(path))).toEqual([]);
		expect((await getGroupByDid(harness.db, LINKED))?.name).toBe(NAME);
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
			getTokenInfo: async () => ({ scope: `atproto ${memberGrant(LINKED)}` }),
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
// Each refusal is tested in ./server/event-writer.test.ts; these check what the
// form gets back.
describe('placement on the event commands', () => {
	const LINKED = 'did:plc:linkedgroupaaaaaaaaaaaaa';
	/** Written out, not taken from the app. */
	const CALENDAR = `at://${LINKED}/space/rsvp.atmo.group.calendar/self`;

	type EventResult = GroupFormResult<{ uri: string }>;
	const put = putGroupEvent as unknown as (data: Record<string, unknown>) => Promise<EventResult>;
	const remove = removeGroupEvent as unknown as (
		data: Record<string, unknown>
	) => Promise<EventResult>;

	let pds: ReturnType<typeof stubPds>;
	let uris: Awaited<ReturnType<typeof provisionGroupSpaces>>;

	const event = () => ({
		name: 'Linked meetup',
		createdAt: '2026-09-01T12:00:00.000Z',
		startsAt: '2026-09-20T18:00:00.000Z',
		mode: 'community.lexicon.calendar.event#inperson',
		status: 'community.lexicon.calendar.event#scheduled'
	});

	beforeEach(async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		pds = stubPds({ did: LINKED, handle: 'linked.group.stub.test' });
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

	it('the event commands take a placement of everyone or members, never left out', () => {
		const schemaOf = (command: unknown) =>
			(command as { schema: v.GenericSchema<unknown, unknown> }).schema;
		const valid = (command: unknown, data: Record<string, unknown>) =>
			v.safeParse(schemaOf(command), data).success;

		const putting = { groupDid: LINKED, rkey: '3abc', intent: 'create', record: event() };
		const removing = { groupDid: LINKED, rkey: '3abc' };
		for (const [command, data] of [
			[putGroupEvent, putting],
			[removeGroupEvent, removing]
		] as const) {
			expect(valid(command, { ...data, placement: 'everyone' })).toBe(true);
			expect(valid(command, { ...data, placement: 'members' })).toBe(true);
			expect(valid(command, data)).toBe(false);
			for (const placement of [undefined, null, '', 'public', 'Members only', CALENDAR]) {
				expect(valid(command, { ...data, placement })).toBe(false);
			}
		}
	});

	// The page sends who can see the event, never where it goes: the writer
	// computes the group's own calendar space from its DID, so no field a caller
	// sends can aim an event at the about space, which a public group lets anyone
	// read.
	it("a members-only event goes to the group's own calendar space, whatever else is sent", async () => {
		expect(
			await put({
				groupDid: LINKED,
				rkey: '3abc',
				intent: 'create',
				placement: 'members',
				space: uris.aboutSpaceUri,
				record: event()
			})
		).toMatchObject({ ok: true });
		expect(pds.spaceWrites.map((w) => w.space)).toEqual([CALENDAR]);
	});

	it('a command with no placement is refused, never written in public, even past the schema', async () => {
		const refused = formError(new GroupPlacementError('no-placement'));
		expect(
			await put({ groupDid: LINKED, rkey: '3abc', intent: 'create', record: event() })
		).toEqual(refused);
		expect(await remove({ groupDid: LINKED, rkey: '3abc' })).toEqual(refused);
		expect(pds.writes()).toEqual([]);
	});

	it('a placement refusal reaches the form as a message, not a 500', async () => {
		const calendar = pds.spaces.get(CALENDAR)!;
		pds.spaces.set(CALENDAR, {
			...calendar,
			readPolicy: { $type: 'com.atproto.simplespace.defs#publicPolicy' }
		});

		// Resolving at all is the point: a throw here would be the 500.
		await expect(
			put({
				groupDid: LINKED,
				rkey: '3new',
				intent: 'create',
				placement: 'members',
				record: event()
			})
		).resolves.toEqual(formError(new GroupPlacementError('calendar-space-readable')));
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
	const CALENDAR = `at://${LINKED}/space/rsvp.atmo.group.calendar/self`;
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
		signInAs(`atproto ${memberGrant(LINKED)}`);
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

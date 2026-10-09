// The in-Worker half of `scripts/groups-e2e.mjs`, bundled by Vite and run by
// Miniflare. It holds no rules and no assertions: each op is a JSON door onto
// the $lib/groups modules, which make every decision.
//
// The run makes its group with the app's own create (`runCreateGroup`), which
// mints a new account on the devnet PDS each run.
//
// Not deployed, not routed, never imported by the app. `scripts/` is outside
// tsconfig's include, like scripts/geocode-events.ts.
import {
	can,
	type GroupPermission,
	type GroupRoleName,
	type AssignableRole
} from '../src/lib/groups/permissions';
import type { GroupRow, GroupVisibility } from '../src/lib/groups/types';

import {
	checkCalendarSpace,
	deleteGroupEvent,
	groupEventLocator,
	uploadGroupEventImage,
	writeGroupEvent
} from '../src/lib/groups/server/event-writer';
import {
	GROUP_ACCEPTANCE_COLLECTION,
	GROUP_ACCEPTANCE_RKEY
} from '../src/lib/groups/members-record';
import { listGroupEvents } from '../src/lib/groups/server/events-index';
import { ensureInit } from '../src/lib/contrail/index';
import { splitRuleLines } from '../src/lib/groups/about-record';
import { reconcileGroupDeclaration } from '../src/lib/groups/server/declaration-writer';
import { setGroupRules } from '../src/lib/groups/server/about-writer';
import { groupSpaceReader, readGroupAbout } from '../src/lib/groups/server/about-read';

import { readGroupVisibility, setAboutSpaceReadPolicy } from '../src/lib/groups/server/spaces';
import {
	rebuildGroup,
	rebuildGroupCache,
	rebuildGroupMembers
} from '../src/lib/groups/server/rebuild';
import {
	effectivePermissions,
	hasAuthzRecords,
	hasMemberRecords,
	hasRecordedAccess,
	readGroupMembers,
	readGroupSpaceIndex,
	rosterFromRecords,
	rosterFromRows
} from '../src/lib/groups/server/members-read';
import { writeGroupAuthz, writeGroupSpaceIndex } from '../src/lib/groups/server/members-writer';
import {
	admitFromRequest,
	admitMember,
	joinGroup,
	ejectMember,
	leaveGroup,
	promoteMember,
	type RosterContext
} from '../src/lib/groups/server/roster';
import {
	acceptOnSignIn,
	writeMissingAcceptances,
	type MemberSession
} from '../src/lib/groups/server/acceptance';
import { memberGrant } from '../src/lib/groups/server/member-grants';
import {
	deleteMembersOnlyRsvp,
	putMembersOnlyRsvp,
	readOwnMembersOnlyRsvp
} from '../src/lib/groups/server/member-rsvp';

import {
	didSpaceHosts,
	groupAcceptanceReader,
	spaceCredential,
	spaceSigHeaders
} from '../src/lib/groups/server/space-credential';
import {
	groupClient,
	resolveGroupCredential,
	GROUP_SESSION_PREFIX
} from '../src/lib/groups/server/session';
import {
	membersOnlyEventForEditing,
	readMembersOnlyEvent,
	readMembersOnlyEvents,
	membersOnlyEventForDisplay
} from '../src/lib/groups/server/calendar-read';
import { setStandInLogin, standInCalls } from './groups-e2e.oauth';
import { runCreateGroup, type CreateGroupData } from '../src/lib/groups/create-group';
import { scopes } from '../src/lib/atproto/settings';

import { groupSpaceUris, type RsvpStatus } from '../src/lib/groups/ids';

import { type EventPlacement } from '../src/lib/groups/event-placement';
import {
	createGroup,
	getGroupByDid,
	getGroupById,
	recordGroupSpaces,
	rolePermissions,
	updateGroup
} from '../src/lib/groups/server/db/groups';
import { listJoinRequests, listMembers } from '../src/lib/groups/server/db/roster';
import { getCallerMembership } from '../src/lib/groups/server/standing';
import { isHttpError } from '@sveltejs/kit';
import { groupRouteContext } from '../src/lib/groups/server/route-context';
import { groupEditorPage } from '../src/lib/groups/server/editor-page';
interface Env {
	DB: D1Database;
	/** Where the app looks for the group's linked session, as in production. */
	OAUTH_SESSIONS: KVNamespace;
	/** What the app's create mints with, as on a deployment. */
	GROUP_PDS_SERVICE: string;
	GROUP_HANDLE_DOMAIN: string;
	GROUP_PDS_INVITE_CODE: string;
	/** Only for the create's check that linking is configured. */
	OAUTH_PUBLIC_URL: string;
	/** Where the stand-in sessions log in (./groups-e2e.oauth.ts, `adminSession`). */
	E2E_GROUP_SERVICE: string;
	/** The admin's login, for the stand-in of their own session (`adminSession`). */
	E2E_ADMIN_PASSWORD: string;
}

/** Args are already-parsed JSON from the driver, which is the only caller. */
type Args = Record<string, unknown>;

/** The visibility the driver chose at create, since D1 does not store it. A
 *  missing value throws rather than being guessed. */
function chosenVisibility(args: Args): GroupVisibility {
	if (args.visibility === 'public' || args.visibility === 'private') return args.visibility;
	throw new Error(`expected visibility 'public' or 'private', got ${String(args.visibility)}`);
}

async function groupById(env: Env, groupId: unknown): Promise<GroupRow> {
	const row = await getGroupById(env.DB, String(groupId));
	if (!row) throw new Error(`no group ${String(groupId)} in D1`);
	return row;
}

// One admin login per isolate, as the group's stand-in does.
let adminLogin: Promise<{ did: string; accessJwt: string }> | null = null;

/** The stand-in for the admin's own session, for their acceptance and their
 *  RSVP. A sign-in would carry the group's grant in its scope; a password
 *  session needs none at the PDS, so the scope here is that grant, as the app
 *  builds it. What it cannot show is a real sign-in's consent, or the PDS
 *  holding an OAuth session to that grant; a walk through a deployed site
 *  covers that. */
async function adminSession(env: Env, did: string, group: GroupRow): Promise<MemberSession> {
	adminLogin ??= (async () => {
		const res = await fetch(
			new URL('/xrpc/com.atproto.server.createSession', env.E2E_GROUP_SERVICE),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ identifier: did, password: env.E2E_ADMIN_PASSWORD })
			}
		);
		// The DID is safe to name; the password never is.
		if (!res.ok) throw new Error(`stand-in login for ${did} was refused (${res.status})`);
		return (await res.json()) as { did: string; accessJwt: string };
	})().catch((e) => {
		adminLogin = null;
		throw e;
	});
	const { did: loggedIn, accessJwt } = await adminLogin;
	if (loggedIn !== did) throw new Error(`the admin login is ${loggedIn}, not ${did}`);
	return {
		did,
		scope: memberGrant(group.group_did),
		handle: (pathname, init) => {
			const headers = new Headers(init.headers);
			headers.set('authorization', `Bearer ${accessJwt}`);
			return fetch(new URL(pathname, env.E2E_GROUP_SERVICE), { ...init, headers });
		}
	};
}

// Every request the app sent through a no-spaces member's session. The driver
// expects none.
const noSpacesCalls: string[] = [];

/** The stand-in for the session of a member whose PDS serves no spaces. Its
 *  scope is what atmo asks for with the group's space grant dropped, as a stock
 *  PDS drops a space grant it does not know. It never logs in, because the run
 *  writes nothing to their repo: a request sent through it is recorded and
 *  refused, so none reaches their PDS. */
function noSpacesSession(did: string): MemberSession {
	return {
		did,
		scope: scopes.join(' '),
		handle: async (pathname) => {
			noSpacesCalls.push(pathname);
			throw new Error(`the no-spaces member's session was asked for ${pathname}`);
		}
	};
}

/** The stand-in for a non-member's session: it holds the group's grant, so only
 *  the roster gate can stop a request, and it records and refuses any request,
 *  so none reaches their PDS. */
function outsiderSession(did: string, group: GroupRow, calls: string[]): MemberSession {
	return {
		did,
		scope: memberGrant(group.group_did),
		handle: async (pathname) => {
			calls.push(pathname);
			throw new Error(`the outsider's session was asked for ${pathname}`);
		}
	};
}

/** `member`, with every request it is asked for recorded in `calls`. */
function recorded(member: MemberSession, calls: string[]): MemberSession {
	return {
		...member,
		handle: (pathname, init) => {
			calls.push(pathname);
			return member.handle(pathname, init);
		}
	};
}

/** One of a member's records in one of the group's spaces, read the way the
 *  roster reads an acceptance: the group's space credential, signed, at the
 *  member's PDS, by DID. Made here without the app's reader so the driver sees
 *  the host's own answer, which the reader folds into absent. */
async function groupReadAt(
	env: Env,
	group: GroupRow,
	space: string,
	did: string,
	collection: string,
	rkey: string
) {
	const cred = await resolveGroupCredential(env, group.group_did);
	if (!cred) throw new Error(`no credential for ${group.group_did}`);
	const { handle } = await groupClient(cred, group.group_did);
	const credential = await spaceCredential(
		handle,
		space,
		await didSpaceHosts.spaceHost(group.group_did)
	);
	const host = await didSpaceHosts.repoHost(did);
	const query = new URLSearchParams({ space, repo: did, collection, rkey });
	const res = await fetch(new URL(`/xrpc/com.atproto.space.getRecord?${query}`, host), {
		headers: await spaceSigHeaders(credential.signer, `Atproto-Space ${credential.token}`, did)
	});
	const body = (await res.json().catch(() => ({}))) as {
		error?: string;
		uri?: string;
		value?: unknown;
	};
	return {
		host,
		status: res.status,
		error: body.error ?? null,
		uri: body.uri ?? null,
		value: body.value ?? null
	};
}

/** A roster act's context. The driver names the caller on every call, and
 *  `asMember` hands the act the caller's own session, as the join and leave
 *  forms do: the admin's, or with `session: 'no-spaces'` the no-spaces member's. */
async function rosterCtx(env: Env, args: Args): Promise<RosterContext> {
	const group = await groupById(env, args.groupId);
	const callerDid = String(args.callerDid);
	let member: MemberSession | null = null;
	if (args.asMember) {
		member =
			args.session === 'no-spaces'
				? noSpacesSession(callerDid)
				: await adminSession(env, callerDid, group);
	}
	return { db: env.DB, env, group, callerDid, member };
}

/** The group's own space reader. The members space is readable only with the
 *  group's session. */
async function spaceReader(env: Env, group: GroupRow) {
	const reader = await groupSpaceReader(env, group);
	if (!reader) throw new Error(`no credential for ${group.group_did}`);
	return reader;
}

const ops: Record<string, (env: Env, args: Args) => Promise<unknown>> = {
	/** The app's own create, as the create form runs it: it mints the group's
	 *  account on the devnet PDS and sets the group up. The owner's recovery key
	 *  never leaves the worker, only whether the create handed one back. */
	runCreateGroup: async (env, args) => {
		// A deployment's index has its tables before any request. This worker's D1
		// starts empty, and without them the create's identity row cannot land, so
		// the index would resolve the new DID over the network.
		await ensureInit(env.DB);
		const outcome = await runCreateGroup(env, String(args.ownerDid), args.data as CreateGroupData);
		const registered = outcome.ok ? outcome : 'registered' in outcome ? outcome.registered : null;
		return {
			ok: outcome.ok,
			error: outcome.ok ? null : outcome.error,
			groupDid: registered?.groupDid ?? null,
			handle: registered?.handle ?? null,
			hasRecoveryKey: Boolean(registered?.recoveryKey)
		};
	},

	/** Marks the group linked, as its owner's link would. The app finds a linked
	 *  session by this key; restoring it is the stand-in's (./groups-e2e.oauth.ts),
	 *  which logs in with the password the create set. */
	linkGroup: async (env, args) => {
		await env.OAUTH_SESSIONS.put(GROUP_SESSION_PREFIX + String(args.groupDid), '{}');
		setStandInLogin(String(args.groupDid), String(args.password));
		return { linked: args.groupDid };
	},

	groupByDid: async (env, args) => {
		const row = await getGroupByDid(env.DB, String(args.groupDid));
		if (!row) throw new Error(`no group ${String(args.groupDid)} in D1`);
		return row;
	},

	/** A bare row on the group's DID, with its spaces recorded, for cleanup to act
	 *  through when check 23's rebuild did not leave one. */
	bindRow: async (env, args) => {
		const groupDid = String(args.groupDid);
		const row = await createGroup(env.DB, {
			groupDid,
			ownerDid: String(args.ownerDid),
			name: 'groups e2e'
		});
		await recordGroupSpaces(env.DB, row.id, groupSpaceUris(groupDid));
		return (await getGroupByDid(env.DB, groupDid)) ?? row;
	},

	/** Stored bundles, as rows: the seeded data, not the constant it came from. */
	rolePermissions: (env, args) => rolePermissions(env.DB, String(args.groupId)),

	listMembers: (env, args) => listMembers(env.DB, String(args.groupId)),

	listJoinRequests: (env, args) =>
		listJoinRequests(env.DB, String(args.groupId), (args.status as 'pending' | 'all') ?? 'pending'),

	/** The app's own permission answer, plus `can()` for each probed name. Once
	 *  the members space holds an authz config, it comes from the records. */
	membership: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const membership = await getCallerMembership(
			env.DB,
			group,
			args.did == null ? null : String(args.did),
			await groupSpaceReader(env, group)
		);
		const probe = (args.probe as GroupPermission[]) ?? [];
		return {
			did: membership.did,
			role: membership.role,
			pendingRequestId: membership.pendingRequestId,
			permissions: [...membership.permissions].sort(),
			onRoster: membership.onRoster,
			can: Object.fromEntries(probe.map((p) => [p, can(membership.permissions, p)]))
		};
	},

	/** The write gate. `callerDid` is the person acting; the credential and repo
	 *  are the group's. `record` has the shape atmo's event editor builds.
	 *  `placement` is passed on as sent: a driver that leaves it out gets the
	 *  writer's refusal. */
	writeGroupEvent: async (env, args) =>
		writeGroupEvent({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			intent: args.intent as 'create' | 'update',
			rkey: args.rkey as string | undefined,
			placement: args.placement as EventPlacement,
			record: args.record as Record<string, unknown>
		}),

	/** The editor's image upload, into the group's repo. `bytes` is a number
	 *  array, as the editor's command sends it. */
	uploadGroupEventImage: async (env, args) =>
		uploadGroupEventImage({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			intent: args.intent as 'create' | 'update',
			bytes: new Uint8Array(args.bytes as number[]),
			mimeType: String(args.mimeType)
		}),

	/** The delete, at the placement the driver names, as `writeGroupEvent`. */
	deleteGroupEvent: async (env, args) =>
		deleteGroupEvent({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			rkey: String(args.rkey),
			placement: args.placement as EventPlacement
		}),

	/** How many requests the app has sent through the group's session, and with
	 *  `from`, the ones since then, so the driver can count what one op sent. */
	groupCalls: async (_env, args) => ({
		total: standInCalls.length,
		calls: args.from == null ? [] : standInCalls.slice(Number(args.from))
	}),

	/** The calendar space check a members-only write makes first, run alone on
	 *  `space` through the app's own reader. Read-only: it never writes, so a
	 *  space it is pointed at that does not exist still does not exist after.
	 *  Answers with the refusal, if any, and every request it sent. */
	calendarSpaceCheck: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const from = standInCalls.length;
		let refusal: ReturnType<typeof serializeError> | null = null;
		try {
			await checkCalendarSpace(await groupEventLocator(env, group), String(args.space));
		} catch (error) {
			refusal = serializeError(error);
		}
		return { refusal, calls: standInCalls.slice(from) };
	},

	/** The events tab's list, from the app's index and not from the PDS. */
	listGroupEvents: async (env, args) => listGroupEvents(env.DB, await groupById(env, args.groupId)),

	/** The route's two calls: read the current rules, then reconcile them. */
	setGroupRules: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const reader = await groupSpaceReader(env, group);
		if (!reader) throw new Error(`no credential for ${group.group_did}`);
		const about = await readGroupAbout(reader, group);
		return setGroupRules({
			db: env.DB,
			env,
			group,
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			desired: splitRuleLines(String(args.rules ?? '')),
			existing: about.rules
		});
	},

	/** Read back through the group's own session, the way the app reads it. */
	readGroupAbout: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const reader = await groupSpaceReader(env, group);
		if (!reader) throw new Error(`no credential for ${group.group_did}`);
		return readGroupAbout(reader, group);
	},

	rebuildGroupCache: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const reader = await groupSpaceReader(env, group);
		if (!reader) throw new Error(`no credential for ${group.group_did}`);
		const outcome = await rebuildGroupCache(env.DB, reader, group);
		return { ...outcome, row: await groupById(env, args.groupId) };
	},

	/** The settings save's own call, behind MANAGE_GROUP. */
	setReadPolicy: async (env, args) => {
		await setAboutSpaceReadPolicy({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			visibility: chosenVisibility(args)
		});
		return { visibility: args.visibility };
	},

	/** The join form's roster act. It is passed no visibility, so it asks the host. */
	joinGroup: async (env, args) => ({
		outcome: await joinGroup(await rosterCtx(env, args), (args.message as string | null) ?? null)
	}),

	/** The leave form's roster act. */
	leaveGroup: async (env, args) => {
		await leaveGroup(await rosterCtx(env, args));
		return { left: args.callerDid };
	},

	/** The approve button's roster act: row, record and both member lists. */
	admitFromRequest: async (env, args) =>
		admitFromRequest(
			await rosterCtx(env, args),
			String(args.requestId),
			(args.role as AssignableRole) ?? 'member'
		),

	/** What the sign-in callback runs for the caller (acceptOnSignIn, without the
	 *  OAuth session it reads the scope from). */
	signInAcceptances: async (env, args) => {
		const group = await groupById(env, args.groupId);
		await writeMissingAcceptances(env.DB, await adminSession(env, String(args.did), group));
		return { signedIn: args.did };
	},

	/** The sign-in callback's own call, for the no-spaces member: acceptOnSignIn
	 *  with a session that answers the scope their PDS granted. Only the groups
	 *  half of a sign-in runs here; the token exchange needs a real consent. */
	signInCallback: async (env, args) => {
		const member = noSpacesSession(String(args.did));
		const session = {
			did: member.did,
			getTokenInfo: async () => ({ scope: member.scope }),
			handle: member.handle
		} as unknown as Parameters<typeof acceptOnSignIn>[1];
		await acceptOnSignIn(env.DB, session);
		return { signedIn: args.did };
	},

	/** What the app sent through no-spaces members' sessions so far. */
	noSpacesCalls: async () => [...noSpacesCalls],

	/** The roster's read of one member's acceptance in the members space
	 *  (`groupReadAt`). */
	spaceReadAt: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const space = group.members_space_uri;
		if (!space) throw new Error(`${group.group_did} has no members space`);
		const { host, status, error } = await groupReadAt(
			env,
			group,
			space,
			String(args.did),
			GROUP_ACCEPTANCE_COLLECTION,
			GROUP_ACCEPTANCE_RKEY
		);
		return { host, status, error };
	},

	/** The group's own read of one member's RSVP in the calendar space, at the
	 *  event's key (`groupReadAt`): what the attendee list will read. */
	calendarReadAt: async (env, args) => {
		const group = await groupById(env, args.groupId);
		return groupReadAt(
			env,
			group,
			groupSpaceUris(group.group_did).calendarSpaceUri,
			String(args.did),
			'community.lexicon.calendar.rsvp',
			String(args.rkey)
		);
	},

	/** A member's RSVP to a members-only event, run through the module the RSVP
	 *  commands and the event page call: `action` 'put', 'delete' or 'read' (the
	 *  page's read-back) for the caller `did`, behind the gate the commands run
	 *  (`groupRouteContext`). The session is the admin's stand-in, or with `session: 'no-spaces'`
	 *  the no-spaces member's, or with `session: 'outsider'` one that holds the
	 *  grant and refuses any request. `stamp` stands for the session's own (0 when
	 *  absent), `asked` is the marker the page would carry back (null when
	 *  absent), and a put sends `cid` as the version of the event the page
	 *  showed. The put reads the event with the group's own space reader, as the
	 *  command does. reauthorize() is a stand-in that answers `reauthorizeUrl`
	 *  (null when absent) and is never followed. Returns the module's answer,
	 *  every request sent through the caller's session, and how many times
	 *  reauthorize() was called. */
	membersOnlyRsvp: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const did = String(args.did);
		const { membership, reader } = await groupRouteContext(env, env.DB, group.group_did, did);
		const calls: string[] = [];
		const member =
			args.session === 'no-spaces'
				? recorded(noSpacesSession(did), calls)
				: args.session === 'outsider'
					? outsiderSession(did, group, calls)
					: recorded(await adminSession(env, did, group), calls);
		let reauthorized = 0;
		const target = {
			membership,
			group,
			member,
			rkey: String(args.rkey),
			callerDid: did,
			stamp: typeof args.stamp === 'number' ? args.stamp : 0,
			asked: typeof args.asked === 'string' ? args.asked : null,
			reauthorize: async () => {
				reauthorized++;
				return args.reauthorizeUrl == null ? null : String(args.reauthorizeUrl);
			}
		};
		let result: unknown;
		if (args.action === 'put') {
			result = await putMembersOnlyRsvp({
				...target,
				status: args.status as RsvpStatus,
				cid: typeof args.cid === 'string' ? args.cid : null,
				groupReader: async () => reader
			});
		} else if (args.action === 'delete') {
			result = await deleteMembersOnlyRsvp(target);
		} else if (args.action === 'read') {
			result = await readOwnMembersOnlyRsvp(membership, group, member, target.rkey);
		} else {
			throw new Error(`unknown RSVP action ${String(args.action)}`);
		}
		return { onRoster: membership.onRoster, result, calls, reauthorized };
	},

	/** The roster as the members page shows it: the records, each entry marked
	 *  confirmed or not from the acceptances read by DID with the group's
	 *  credential. `confirmed` is null when they could not be read. */
	confirmedRoster: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const members = await readGroupMembers(await spaceReader(env, group), group);
		const dids = members.memberships.map((record) => record.subject);
		const acceptances = await groupAcceptanceReader(env, group);
		const space = group.members_space_uri;
		const accepted =
			acceptances && space && dids.length > 0 ? await acceptances.accepted(space, dids) : null;
		return {
			roster: rosterFromRecords(members, accepted).map((entry) => ({
				did: entry.did,
				role: entry.role,
				confirmed: entry.confirmed
			}))
		};
	},

	/** The gate every group page runs, for one caller (`groupRouteContext`).
	 *  `canSee` is false for its 404. `visibility` is null for a caller on the
	 *  roster, whom the gate lets in without asking the host. */
	gate: async (env, args) => {
		const group = await groupById(env, args.groupId);
		try {
			const context = await groupRouteContext(
				env,
				env.DB,
				group.group_did,
				args.did == null ? null : String(args.did)
			);
			return {
				canSee: true,
				onRoster: context.membership.onRoster,
				visibility: context.visibility
			};
		} catch (e) {
			if (isHttpError(e) && e.status === 404) {
				return { canSee: false, onRoster: false, visibility: null };
			}
			throw e;
		}
	},

	/** The events tab's members-only slice for one viewer, or null for a viewer
	 *  off the roster: the gate the events tab runs (`groupRouteContext`), then the
	 *  same $lib function its loader calls. It returns every request sent through the
	 *  group's session: `calls` for the whole op, standing included, and
	 *  `sliceCalls` for the slice read alone. With `unlinked`, the group's stored
	 *  session is taken away for the read, as a lapsed link leaves it, and put
	 *  back before the op returns. */
	membersOnlySlice: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const did = args.did == null ? null : String(args.did);
		const key = GROUP_SESSION_PREFIX + group.group_did;
		const stored = args.unlinked ? await env.OAUTH_SESSIONS.get(key) : null;
		if (args.unlinked) await env.OAUTH_SESSIONS.delete(key);
		try {
			const from = standInCalls.length;
			const { membership, reader } = await groupRouteContext(env, env.DB, group.group_did, did);
			const sliceFrom = standInCalls.length;
			const read = await readMembersOnlyEvents(membership, reader, group);
			// As the events tab shows it: each event without its image.
			const slice = read && { ...read, events: read.events.map(membersOnlyEventForDisplay) };
			return {
				linked: reader !== null,
				onRoster: membership.onRoster,
				slice,
				calls: standInCalls.slice(from),
				sliceCalls: standInCalls.slice(sliceFrom)
			};
		} finally {
			if (args.unlinked && stored !== null) await env.OAUTH_SESSIONS.put(key, stored);
		}
	},

	/** One members-only event by its key for one viewer, as its page reads it.
	 *  The gate the event page runs (`groupRouteContext`), then the same $lib
	 *  function its loader calls. It returns every request sent through the group's
	 *  session: `calls` for the whole op, standing included, and `readCalls` for
	 *  the event read alone. */
	membersOnlyEvent: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const did = args.did == null ? null : String(args.did);
		const from = standInCalls.length;
		const { membership, reader } = await groupRouteContext(env, env.DB, group.group_did, did);
		const readFrom = standInCalls.length;
		const read = await readMembersOnlyEvent(membership, reader, group, String(args.rkey));
		return {
			linked: reader !== null,
			onRoster: membership.onRoster,
			read,
			calls: standInCalls.slice(from),
			readCalls: standInCalls.slice(readFrom)
		};
	},

	/** The edit page's read of one members-only event for one caller: the editor
	 *  gate the page runs (`groupEditorPage`), then for a caller it lets through
	 *  the same $lib read and edit copy the loader calls. `allowed` is false for
	 *  the gate's 403; the caller's standing is then read afterwards, only to
	 *  report it. It returns every request sent through the group's session:
	 *  `calls` for the whole op, and `readCalls` for what came after the gate. */
	membersOnlyEditRead: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const did = args.did == null ? null : String(args.did);
		const from = standInCalls.length;
		let page;
		try {
			page = await groupEditorPage(env, group.group_did, did, 'MANAGE_EVENTS');
		} catch (e) {
			if (!(isHttpError(e) && e.status === 403)) throw e;
			const calls = standInCalls.slice(from);
			const standing = await getCallerMembership(
				env.DB,
				group,
				did,
				await groupSpaceReader(env, group)
			);
			return {
				onRoster: standing.onRoster,
				allowed: false,
				read: null,
				eventData: null,
				calls,
				readCalls: []
			};
		}
		const readFrom = standInCalls.length;
		const read = await readMembersOnlyEvent(
			page.membership,
			page.reader,
			page.group,
			String(args.rkey)
		);
		return {
			onRoster: page.membership.onRoster,
			allowed: true,
			read,
			eventData:
				read.status === 'found' ? membersOnlyEventForEditing(read.event, page.group) : null,
			calls: standInCalls.slice(from),
			readCalls: standInCalls.slice(readFrom)
		};
	},

	/** Whether the app finds the group's stored session, as the pages do. */
	linked: async (env, args) => {
		const group = await groupById(env, args.groupId);
		return { linked: (await resolveGroupCredential(env, group.group_did)) !== null };
	},

	/** Overwrites the profile's columns through the app's own updater, not raw
	 *  SQL, so the damage is one the app itself could cause. */
	corruptGroupCache: async (env, args) => {
		await updateGroup(env.DB, String(args.groupId), {
			name: 'CORRUPTED',
			description: 'CORRUPTED',
			locationName: 'CORRUPTED',
			requireApproval: false
		});
		return groupById(env, args.groupId);
	},

	// ---- the roster, as records ---------------------------------------------

	/** The index of the group's spaces, read first as the repair reads it. The
	 *  calendar space joins it when the driver passes `calendarSpaceUri`, as the
	 *  create does; without it, as the repair does, the index is the two spaces. */
	writeSpaceIndex: async (env, args) => {
		const group = await groupById(env, args.groupId);
		return writeGroupSpaceIndex({
			db: env.DB,
			env,
			group,
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			existing: await readGroupSpaceIndex(await spaceReader(env, group), group),
			calendarSpace: args.calendarSpaceUri == null ? undefined : String(args.calendarSpaceUri)
		});
	},

	/** The only record a stranger can read. The driver passes a visibility, as the
	 *  settings save does, or `'host'` to use the host's answer, as the repair does. */
	reconcileDeclaration: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const visibility =
			args.visibility === 'host'
				? await readGroupVisibility(await spaceReader(env, group), group)
				: chosenVisibility(args);
		const result = await reconcileGroupDeclaration({
			db: env.DB,
			env,
			group,
			visibility,
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			createdAt: args.createdAt as string | undefined
		});
		return { uri: result?.uri ?? null, visibility };
	},

	/** The authz config: one `role` record per seeded role and the two binding
	 *  records. */
	writeGroupAuthz: async (env, args) =>
		writeGroupAuthz({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			bundles: args.bundles as Record<GroupRoleName, GroupPermission[]> | undefined
		}),

	/** The authz config as the records say it is, plus one role's effective grant. */
	recordedAuthz: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const members = await readGroupMembers(await spaceReader(env, group), group);
		const role = (args.role as GroupRoleName) ?? 'admin';
		return {
			hasAuthz: hasAuthzRecords(members),
			roles: members.roles.map((record) => record.id),
			community: members.permissions?.bindings ?? null,
			modality: members.eventPermissions?.bindings ?? null,
			effective: { role, permissions: [...effectivePermissions(members, [role])].sort() }
		};
	},

	/** The roster acts the app's own handlers call: row plus record, in its order. */
	admitMember: async (env, args) => {
		await admitMember(await rosterCtx(env, args), String(args.did), args.role as AssignableRole);
		return { admitted: args.did };
	},

	promoteMember: async (env, args) => {
		await promoteMember(await rosterCtx(env, args), String(args.did), args.role as AssignableRole);
		return { promoted: args.did, role: args.role };
	},

	ejectMember: async (env, args) => {
		await ejectMember(await rosterCtx(env, args), String(args.did));
		return { ejected: args.did };
	},

	/** The roster as the members page builds it (records if the space holds any,
	 *  else the cache), plus the access answer for one DID. */
	recordedRoster: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const members = await readGroupMembers(await spaceReader(env, group), group);
		const fromRecords = hasMemberRecords(members);
		return {
			source: fromRecords ? 'records' : 'cache',
			roster: fromRecords
				? rosterFromRecords(members)
				: rosterFromRows(await listMembers(env.DB, group.id)),
			access: members.access,
			hasAccess: hasRecordedAccess(members, args.did == null ? null : String(args.did)),
			memberships: members.memberships.map((record) => ({
				rkey: record.rkey,
				subject: record.subject,
				roles: record.roles,
				createdAt: record.createdAt,
				uri: record.uri
			}))
		};
	},

	/** Drops the non-owner roster rows with raw SQL, because no app path deletes
	 *  them in bulk. The `memberships_owner_undeletable` trigger keeps the owner's. */
	dropMembershipRows: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const before = await listMembers(env.DB, group.id);
		await env.DB.prepare(`DELETE FROM memberships WHERE group_id = ? AND did <> ?`)
			.bind(group.id, group.owner_did)
			.run();
		return { dropped: before.length - (await listMembers(env.DB, group.id)).length };
	},

	rebuildGroupMembers: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const outcome = await rebuildGroupMembers(env.DB, await spaceReader(env, group), group);
		return { ...outcome, roster: rosterFromRows(await listMembers(env.DB, group.id)) };
	},

	/** Everything a rebuild must restore, keyed by DID because the row's id changes. */
	groupSnapshot: async (env, args) => {
		const row = await getGroupByDid(env.DB, String(args.groupDid));
		if (!row) return null;
		const roster = await env.DB.prepare(
			`SELECT m.did, r.name AS role, m.created_at FROM memberships m
			 JOIN roles r ON r.id = m.role_id WHERE m.group_id = ? ORDER BY m.did`
		)
			.bind(row.id)
			.all();
		const grants = await env.DB.prepare(
			`SELECT r.name AS role, rp.permission FROM roles r
			 LEFT JOIN role_permissions rp ON rp.role_id = r.id
			 WHERE r.group_id = ? ORDER BY r.name, rp.permission`
		)
			.bind(row.id)
			.all();
		return { row, roster: roster.results, grants: grants.results };
	},

	/** Deletes the group row and, by cascade, its roles, bundles, roster and join
	 *  requests. The linked session is kept outside D1 and survives. A rebuild
	 *  starts from it. */
	dropGroupRows: async (env, args) => {
		const group = await groupById(env, args.groupId);
		await env.DB.prepare(`DELETE FROM groups WHERE id = ?`).bind(group.id).run();
		return { left: await getGroupByDid(env.DB, group.group_did) };
	},

	rebuildGroup: async (env, args) => {
		const groupDid = String(args.groupDid);
		const reader = await groupSpaceReader(env, { group_did: groupDid });
		if (!reader) throw new Error(`no credential for ${groupDid}`);
		return rebuildGroup(env.DB, reader, groupDid);
	}
};

/** Refusals travel as data: the class name and the tags the app routes on, so
 *  the driver never matches on message text. */
function serializeError(error: unknown) {
	const e = error as { name?: string; message?: string; reason?: string; permission?: string };
	return {
		name: e?.name ?? 'Error',
		message: e?.message ?? String(error),
		reason: e?.reason ?? null,
		permission: e?.permission ?? null
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' }
			});

		const { op, args } = (await request.json()) as { op?: string; args?: Args };
		const run = op ? ops[op] : undefined;
		if (!run) return json({ ok: false, error: serializeError(new Error(`unknown op ${op}`)) }, 400);

		try {
			return json({ ok: true, value: await run(env, args ?? ({} as Args)) });
		} catch (error) {
			return json({ ok: false, error: serializeError(error) });
		}
	}
};

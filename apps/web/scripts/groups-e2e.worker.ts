// The in-Worker half of `scripts/groups-e2e.mjs`, bundled by Vite and run by
// Miniflare. It holds no rules and no assertions: each op is a JSON door onto
// the $lib/groups modules, which make every decision. Every person's session is a
// real one the driver holds, reached through its bridge (E2E_BRIDGE).
//
// Not deployed, not routed, never imported by the app.
import { isHttpError } from '@sveltejs/kit';
import { can, type GroupPermission, type GroupRoleName } from '../src/lib/groups/permissions';
import type { GroupRow, GroupVisibility } from '../src/lib/groups/types';
import type { GroupJoinPolicy } from '../src/lib/groups/about-record';
import {
	deleteGroupEvent,
	uploadGroupEventImage,
	writeGroupEvent
} from '../src/lib/groups/server/event-writer';
import { listGroupEvents } from '../src/lib/groups/server/events-index';
import { ensureInit } from '../src/lib/contrail/index';
import { reconcileGroupDeclaration } from '../src/lib/groups/server/declaration-writer';
import {
	groupSpaceReader,
	readGroupAbout,
	type GroupSpaceReader
} from '../src/lib/groups/server/about-read';
import { readGroupVisibility } from '../src/lib/groups/server/spaces';
import { runUpdateGroup } from '../src/lib/groups/update-group';
import {
	hasMemberRecords,
	readGroupMembers,
	resolveActor,
	rolesForDid,
	rosterFromRecords,
	rosterFromRows,
	splitRoster
} from '../src/lib/groups/server/members-read';
import {
	groupHost,
	groupHostOrigin,
	isHostGroup,
	type HostBinding,
	type HostCaller
} from '../src/lib/groups/server/host';
import { holdsMetaRead } from '../src/lib/groups/server/member-grants';
import type { CallerSession } from '../src/lib/groups/server/caller';
import {
	credentialAcceptanceReader,
	didSpaceHosts,
	spaceCredential,
	spaceSigHeaders
} from '../src/lib/groups/server/space-credential';
import { recordMacCheck, WANT_MAC_HEADER } from '../src/lib/groups/server/space-mac';
import {
	groupClient,
	groupSessionKey,
	groupSessionScope,
	requireGroupCredential,
	resolveGroupCredential
} from '../src/lib/groups/server/session';
import { GROUP_SIGN_IN_SCOPES } from '../src/lib/groups/server/sign-in-grants';
import { groupSessionCalls, groupSessionWriters, groupSessionWrites } from './groups-e2e.oauth';
import { setUpHostGroup, type HostCreateFields } from '../src/lib/groups/create-at-host';
import { scopes } from '../src/lib/atproto/settings';
import { getGroupByDid, getGroupById } from '../src/lib/groups/server/db/groups';
import { listMembers } from '../src/lib/groups/server/db/roster';
import { readStanding } from '../src/lib/groups/server/standing';
import {
	callerReader,
	groupRouteContext,
	pageRoster
} from '../src/lib/groups/server/route-context';
import type { OAuthSession } from '@atcute/oauth-node-client';
import type { EventPlacement } from '../src/lib/groups/event-placement';
import type { RsvpStatus } from '../src/lib/groups/ids';
import { acceptOnSignIn } from '../src/lib/groups/server/acceptance';
import {
	readMembersOnlyEvent,
	readMembersOnlyEvents
} from '../src/lib/groups/server/calendar-read';
import {
	deleteMembersOnlyRsvp,
	putMembersOnlyRsvp,
	readOwnMembersOnlyRsvp
} from '../src/lib/groups/server/member-rsvp';

interface Env {
	DB: D1Database;
	OAUTH_SESSIONS: KVNamespace;
	/** Only for the create's check that linking is configured. */
	OAUTH_PUBLIC_URL: string;
	/** The driver's bridge to each person's real sessions (groups-e2e.signin.mjs). */
	E2E_BRIDGE: string;
	GROUP_HOST_URL: string;
}

type Args = Record<string, unknown>;

function visibilityOf(value: unknown): GroupVisibility {
	if (value === 'public' || value === 'private') return value;
	throw new Error(`expected visibility 'public' or 'private', got ${String(value)}`);
}

const didOf = (value: unknown) => (value == null ? null : String(value));

async function groupById(env: Env, groupId: unknown): Promise<GroupRow> {
	const row = await getGroupById(env.DB, String(groupId));
	if (!row) throw new Error(`no group ${String(groupId)} in D1`);
	return row;
}

const grantedScopes = new Map<string, Promise<string>>();

/** A person's own sign-in at their PDS, held by the driver: each request goes to its
 *  bridge, and the scope is what their PDS granted. */
async function ownSession(env: Env, personDid: string): Promise<CallerSession> {
	let scope = grantedScopes.get(personDid);
	if (!scope) {
		scope = fetch(new URL(`/scope/${encodeURIComponent(personDid)}`, env.E2E_BRIDGE)).then(
			async (res) => {
				if (!res.ok) throw new Error(`the driver holds no sign-in for ${personDid}`);
				return res.text();
			}
		);
		grantedScopes.set(personDid, scope);
		scope.catch(() => grantedScopes.delete(personDid));
	}
	const at = `/own/${encodeURIComponent(personDid)}`;
	return {
		did: personDid,
		scope: await scope,
		handle: (pathname, init) => fetch(new URL(`${at}${pathname}`, env.E2E_BRIDGE), init)
	};
}

/** Every request the app sent through a no-spaces member's session. The driver expects none. */
const noSpacesCalls: string[] = [];

/** A member whose PDS serves no spaces: the scope a stock PDS grants for atmo's sign-in,
 *  every space grant dropped. It records and refuses any request. */
function noSpacesSession(personDid: string): CallerSession {
	return {
		did: personDid,
		scope: scopes.filter((s) => !s.startsWith('space:')).join(' '),
		handle: async (pathname) => {
			noSpacesCalls.push(pathname);
			throw new Error(`the no-spaces member's session was asked for ${pathname}`);
		}
	};
}

/** Every request a read sent with someone's own access, as its path and query. */
const ownCalls: string[] = [];

const sendFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	const authorization = new Headers(init?.headers).get('authorization') ?? '';
	if (
		url.pathname === '/xrpc/com.atproto.space.getSpaceCredential' &&
		typeof init?.body === 'string'
	) {
		const { space } = JSON.parse(init.body) as { space?: unknown };
		ownCalls.push(`${url.pathname}?${new URLSearchParams({ space: String(space) })}`);
	} else if (authorization.startsWith('Atproto-Space-Credential ')) {
		ownCalls.push(url.pathname + url.search);
	}
	return sendFetch(input, init);
};

/** The caller as a page builds it from the sign-in: null for `did: null`, else their
 *  own session (`own`), one whose PDS serves no spaces (`no-spaces`), or a sign-in
 *  without the meta read grant (`no-read`). */
async function callerFor(env: Env, args: Args): Promise<CallerSession | null> {
	if (args.did == null) return null;
	const personDid = String(args.did);
	const kind = args.session ?? 'own';
	if (kind === 'no-spaces') return noSpacesSession(personDid);
	if (kind !== 'own' && kind !== 'no-read') throw new Error(`unknown session ${String(kind)}`);
	const own = await ownSession(env, personDid);
	const scope =
		kind === 'no-read'
			? own.scope
					.split(' ')
					.filter((token) => !holdsMetaRead(token))
					.join(' ')
			: own.scope;
	return {
		...own,
		scope,
		handle: (pathname, init) => {
			ownCalls.push(pathname);
			return own.handle(pathname, init);
		}
	};
}

async function readerFor(env: Env, args: Args): Promise<GroupSpaceReader | null> {
	return callerReader(await callerFor(env, args));
}

/** A roster act's context, as the forms build it: `asMember` hands the act the
 *  caller's own session, as the join and leave forms do. */
async function rosterCtx(env: Env, args: Args, group: GroupRow): Promise<HostBinding & HostCaller> {
	const callerDid = String(args.callerDid);
	const session = args.session === 'no-spaces' ? 'no-spaces' : 'own';
	const member = args.asMember ? await callerFor(env, { did: callerDid, session }) : null;
	const reader = await readerFor(env, { did: callerDid, session });
	return { db: env.DB, env, group, callerDid, member, reader };
}

/** The group's own space reader, through `personDid`'s group session. */
async function spaceReader(env: Env, group: GroupRow, personDid: unknown) {
	const reader = await groupSpaceReader(env, group, String(personDid));
	if (!reader) throw new Error(`no group session of ${String(personDid)} for ${group.group_did}`);
	return reader;
}

function placementOf(args: Args): EventPlacement {
	return args.placement === 'members' ? 'members' : 'everyone';
}

async function rsvpTarget(env: Env, args: Args, group: GroupRow) {
	const member = await callerFor(env, args);
	const ownReader = callerReader(member);
	return {
		membership: await readStanding(env.DB, group, didOf(args.did), ownReader),
		group,
		member,
		ownReader,
		rkey: String(args.rkey),
		reauthorized: args.reauthorized === true,
		reauthorize: async () => null
	};
}

const ops: Record<string, (env: Env, args: Args, group: GroupRow) => Promise<unknown>> = {
	/** Stores `personDid`'s group session, as their own link would. */
	linkGroup: async (env, args) => {
		const personDid = String(args.personDid);
		await env.OAUTH_SESSIONS.put(
			groupSessionKey(String(args.groupDid), personDid),
			JSON.stringify({ person: personDid })
		);
		return { linked: args.groupDid, by: personDid };
	},

	/** What the create's callback runs once the host has made the group. */
	setUpHostGroup: async (env, args) => {
		await ensureInit(env.DB);
		const groupDid = String(args.groupDid);
		const ownerDid = String(args.ownerDid);
		const atHost = await isHostGroup(env, groupDid);
		const credential = await resolveGroupCredential(env, groupDid, ownerDid);
		if (!credential) throw new Error(`no group session of ${ownerDid}'s is stored for ${groupDid}`);
		const outcome = await setUpHostGroup(
			env,
			ownerDid,
			args.fields as HostCreateFields,
			credential,
			groupHostOrigin(env)!
		);
		return { ok: outcome.ok, error: outcome.ok ? null : outcome.error, groupDid, atHost };
	},

	/** The scope a link asks for, and the one a sign-in asks for first. */
	scopes: async () => ({
		link: groupSessionScope(),
		signIn: [...scopes, ...GROUP_SIGN_IN_SCOPES].join(' ')
	}),

	groupByDid: async (env, args) => {
		const row = await getGroupByDid(env.DB, String(args.groupDid));
		if (!row) throw new Error(`no group ${String(args.groupDid)} in D1`);
		return row;
	},

	listMembers: (env, args) => listMembers(env.DB, String(args.groupId)),

	listJoinRequests: async (env, args, group) => {
		const ctx = await rosterCtx(env, args, group);
		return (await groupHost(ctx)).listJoinRequests(ctx);
	},

	/** The app's permission answer, read with the caller's own access, plus `can()`
	 *  for each probed name. */
	membership: async (env, args, group) => {
		const membership = await readStanding(
			env.DB,
			group,
			didOf(args.did),
			await readerFor(env, args)
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

	writeGroupEvent: async (env, args, group) =>
		writeGroupEvent({
			db: env.DB,
			env,
			group,
			callerDid: didOf(args.callerDid),
			reader: await readerFor(env, { did: args.callerDid }),
			intent: args.intent as 'create' | 'update',
			rkey: args.rkey as string | undefined,
			placement: placementOf(args),
			record: args.record as Record<string, unknown>
		}),

	uploadGroupEventImage: async (env, args, group) =>
		uploadGroupEventImage({
			db: env.DB,
			env,
			group,
			callerDid: didOf(args.callerDid),
			reader: await readerFor(env, { did: args.callerDid }),
			intent: args.intent as 'create' | 'update',
			bytes: new Uint8Array(args.bytes as number[]),
			mimeType: String(args.mimeType)
		}),

	deleteGroupEvent: async (env, args, group) =>
		deleteGroupEvent({
			db: env.DB,
			env,
			group,
			callerDid: didOf(args.callerDid),
			reader: await readerFor(env, { did: args.callerDid }),
			rkey: String(args.rkey),
			placement: placementOf(args)
		}),

	/** The requests sent through the group's session, and with `from`, the ones since. */
	groupCalls: async (_env, args) => ({
		total: groupSessionCalls.length,
		calls: args.from == null ? [] : groupSessionCalls.slice(Number(args.from))
	}),

	/** The writes among those calls, labelled by collection, and whose session sent each. */
	groupWrites: async (_env, args) => ({
		total: groupSessionWrites.length,
		writes: args.from == null ? [] : groupSessionWrites.slice(Number(args.from)),
		by: args.from == null ? [] : groupSessionWriters.slice(Number(args.from))
	}),

	listGroupEvents: async (env, _args, group) => listGroupEvents(env.DB, group),

	readGroupAbout: async (env, args, group) =>
		readGroupAbout(await spaceReader(env, group, args.personDid), group),

	/** The settings form's save: name and description sent back as they stand. */
	saveSettings: async (env, args, group) =>
		runUpdateGroup(
			env,
			env.DB,
			group,
			{ did: String(args.callerDid), reader: await readerFor(env, { did: args.callerDid }) },
			{
				name: group.name,
				description: group.description ?? undefined,
				visibility: visibilityOf(args.visibility),
				shownVisibility: visibilityOf(args.shownVisibility),
				joinPolicy: (args.joinPolicy as GroupJoinPolicy | undefined) ?? 'approval',
				listed: args.listed !== false
			}
		),

	joinGroup: async (env, args, group) => {
		const ctx = await rosterCtx(env, args, group);
		const host = await groupHost(ctx);
		return { outcome: await host.requestJoin(ctx, (args.message as string | undefined) ?? null) };
	},

	leaveGroup: async (env, args, group) => {
		const ctx = await rosterCtx(env, args, group);
		await (await groupHost(ctx)).leaveGroup(ctx);
		return { left: args.callerDid };
	},

	approveJoinRequest: async (env, args, group) => {
		const ctx = await rosterCtx(env, args, group);
		const role = (args.role as GroupRoleName | undefined) ?? 'member';
		await (await groupHost(ctx)).approveJoinRequest(ctx, String(args.member), role);
		return { approved: args.member };
	},

	noSpacesCalls: async () => [...noSpacesCalls],

	/** A record read at `did`'s PDS with the group's space credential, through
	 *  `personDid`'s group session, so the driver sees that PDS's own answer. */
	spaceReadAt: async (env, args, group) => {
		const space = String(args.space ?? group.members_space_uri);
		const { handle } = await groupClient(
			await requireGroupCredential(env, group.group_did, String(args.personDid)),
			group.group_did
		);
		const credential = await spaceCredential(
			{ did: group.group_did, handle },
			space,
			await didSpaceHosts.repoHost(group.group_did)
		);
		const target = String(args.did);
		const host = await didSpaceHosts.repoHost(target);
		const query = new URLSearchParams({
			space,
			repo: target,
			collection: 'group.opensocial.membership',
			rkey: 'self'
		});
		const kemKey = await didSpaceHosts.kemKey(target).catch(() => null);
		const mac = kemKey ? await recordMacCheck(kemKey) : null;
		const res = await fetch(new URL(`/xrpc/com.atproto.space.getRecord?${query}`, host), {
			headers: {
				...(await spaceSigHeaders(
					credential.signer,
					`Atproto-Space-Credential ${credential.token}`,
					target
				)),
				...(mac ? { [WANT_MAC_HEADER]: mac.header } : {})
			}
		});
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		return { host, status: res.status, error: body.error ?? null };
	},

	/** The gate every group page runs, for one caller. `canSee` is false for its 404;
	 *  `groupCalls` is every request it sent as the group, which should be none. */
	gate: async (env, args, group) => {
		const from = groupSessionCalls.length;
		const ownFrom = ownCalls.length;
		try {
			const context = await groupRouteContext(env.DB, group.group_did, await callerFor(env, args));
			return {
				canSee: true,
				onRoster: context.membership.onRoster,
				visibility: context.visibility,
				reads: context.reader !== null,
				signIn: context.membership.signIn === true,
				groupCalls: groupSessionCalls.slice(from),
				calls: ownCalls.slice(ownFrom)
			};
		} catch (e) {
			if (!(isHttpError(e) && e.status === 404)) throw e;
			return {
				canSee: false,
				onRoster: false,
				visibility: null,
				reads: false,
				signIn: false,
				groupCalls: groupSessionCalls.slice(from),
				calls: ownCalls.slice(ownFrom)
			};
		}
	},

	/** The declaration, for `visibility` and `listed`, or by the meta access record
	 *  when `visibility` is `'record'`. */
	reconcileDeclaration: async (env, args, group) => {
		const visibility =
			args.visibility === 'record'
				? await readGroupVisibility(await spaceReader(env, group, args.callerDid), group)
				: visibilityOf(args.visibility);
		await reconcileGroupDeclaration({
			db: env.DB,
			env,
			group,
			visibility,
			listed: args.listed !== false,
			callerDid: didOf(args.callerDid)
		});
		return { visibility };
	},

	/** The authz config as the records say it is, and what one role's holder may do. */
	recordedAuthz: async (env, args, group) => {
		const members = await readGroupMembers(await spaceReader(env, group, args.personDid), group);
		const role = String(args.role ?? 'admin');
		const holder = members.memberships.find((m) => m.roles.includes(role))?.subject ?? null;
		return {
			roles: members.roles,
			grants: members.permissions,
			effective: {
				role,
				holder,
				permissions: [...resolveActor(members, holder, group.group_did).permissions].sort()
			}
		};
	},

	admitMember: async (env, args, group) => {
		const ctx = await rosterCtx(env, args, group);
		await (await groupHost(ctx)).addMember(ctx, String(args.did), args.role as GroupRoleName);
		return { admitted: args.did };
	},

	promoteMember: async (env, args, group) => {
		const ctx = await rosterCtx(env, args, group);
		await (await groupHost(ctx)).setMemberRole(ctx, String(args.did), args.role as GroupRoleName);
		return { promoted: args.did, role: args.role };
	},

	ejectMember: async (env, args, group) => {
		const ctx = await rosterCtx(env, args, group);
		await (await groupHost(ctx)).ejectMember(ctx, String(args.did));
		return { ejected: args.did };
	},

	/** The roster as the members page builds it, and whether one DID has a record. */
	/** The members-only slice as the events tab reads it, with `did`'s own access, and the
	 *  requests that read sent. */
	membersOnlyEvents: async (env, args, group) => {
		const reader = await readerFor(env, args);
		const standing = await readStanding(env.DB, group, didOf(args.did), reader);
		const from = ownCalls.length;
		return {
			slice: await readMembersOnlyEvents(standing, reader, group),
			calls: ownCalls.slice(from)
		};
	},

	membersOnlyEvent: async (env, args, group) => {
		const reader = await readerFor(env, args);
		const standing = await readStanding(env.DB, group, didOf(args.did), reader);
		return readMembersOnlyEvent(standing, reader, group, String(args.rkey));
	},

	/** A member's RSVP from their own session. It never starts a new sign-in. */
	rsvp: async (env, args, group) => {
		const target = await rsvpTarget(env, args, group);
		return putMembersOnlyRsvp({
			...target,
			status: args.status as RsvpStatus,
			cid: (args.cid as string | null | undefined) ?? null,
			reader: async () => target.ownReader
		});
	},

	cancelRsvp: async (env, args, group) => deleteMembersOnlyRsvp(await rsvpTarget(env, args, group)),

	ownRsvp: async (env, args, group) => {
		const target = await rsvpTarget(env, args, group);
		return readOwnMembersOnlyRsvp(target.membership, group, target.member, target.rkey);
	},

	/** Whether each of `dids` wrote their acceptance, read with `viewer`'s own credential. */
	acceptances: async (env, args, group) => {
		const viewer = await callerFor(env, { did: args.viewer });
		if (!viewer || !group.members_space_uri) throw new Error('no viewer or no members space');
		const read = await credentialAcceptanceReader(viewer).accepted(
			group.members_space_uri,
			(args.dids as string[]) ?? []
		);
		return Object.fromEntries(read);
	},

	/** The sign-in callback's acceptance step, on `did`'s own session. */
	acceptAtSignIn: async (env, args) => {
		const own = await ownSession(env, String(args.did));
		await acceptOnSignIn(env.DB, {
			did: own.did,
			getTokenInfo: async () => ({ scope: own.scope }),
			handle: own.handle
		} as unknown as OAuthSession);
		return { signedIn: own.did };
	},

	/** The roster as a page shows it to `viewer`: the listed members and the unconfirmed. */
	pageRoster: async (env, args, group) => {
		const viewer = await callerFor(env, { did: args.viewer });
		const members = await readGroupMembers((await readerFor(env, { did: args.viewer }))!, group);
		return splitRoster(await pageRoster(env.DB, group, members, viewer));
	},

	recordedRoster: async (env, args, group) => {
		const members = await readGroupMembers(await spaceReader(env, group, args.personDid), group);
		const fromRecords = hasMemberRecords(members);
		return {
			source: fromRecords ? 'records' : 'cache',
			roster: fromRecords
				? rosterFromRecords(members)
				: rosterFromRows(await listMembers(env.DB, group.id)),
			hasAccess: rolesForDid(members, didOf(args.did)).length > 0,
			memberships: members.memberships.map((m) => ({
				subject: m.subject,
				roles: m.roles,
				createdAt: m.createdAt
			}))
		};
	}
};

/** Refusals travel as data: the class name and the tags the app routes on, so the
 *  driver never matches on message text. */
function serializeError(error: unknown) {
	const e = error as {
		name?: string;
		message?: string;
		reason?: string;
		status?: number;
		error?: string;
		personDid?: string;
	};
	return {
		name: e?.name ?? 'Error',
		message: e?.message ?? String(error),
		reason: e?.reason ?? null,
		status: e?.status ?? null,
		code: e?.error ?? null,
		personDid: e?.personDid ?? null
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
			const given = args ?? ({} as Args);
			const group =
				given.groupId == null
					? (undefined as unknown as GroupRow)
					: await groupById(env, given.groupId);
			return json({ ok: true, value: await run(env, given, group) });
		} catch (error) {
			return json({ ok: false, error: serializeError(error) });
		}
	}
};

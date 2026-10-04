// The in-Worker half of `scripts/groups-e2e.mjs`, bundled by Vite and run by
// Miniflare. It holds no rules and no assertions: each op is a JSON door onto
// the $lib/groups modules, which make every decision.
//
// Several ops do what `runCreateGroup` does around the account it mints. The
// e2e binds an existing DID through `createGroup`, which only writes D1 rows, so
// the driver calls those ops itself.
//
// Not deployed, not routed, never imported by the app. `scripts/` is outside
// tsconfig's include, like scripts/geocode-events.ts.
import { can, type GroupPermission } from '../src/lib/groups/permissions';
import { canSeeGroup } from '../src/lib/groups/access';
import type { GroupRoleName } from '../src/lib/groups/permissions';
import type { GroupRow, GroupVisibility } from '../src/lib/groups/types';
import {
	approveJoinRequest,
	changeMemberRole,
	createGroup,
	getCallerMembership,
	getGroupByDid,
	getGroupById,
	listJoinRequests,
	listMembers,
	recordGroupSpaces,
	removeMember,
	requestJoin,
	rolePermissions,
	updateGroup
} from '../src/lib/groups/server/repo';
import {
	deleteGroupEvent,
	groupWriter,
	uploadGroupEventImage,
	writeGroupEvent
} from '../src/lib/groups/server/event-writer';
import {
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	GROUP_SPACE_COLLECTION
} from '../src/lib/groups/members-record';
import { listGroupEvents, registerGroupIdentity } from '../src/lib/groups/server/events-index';
import { splitRuleLines } from '../src/lib/groups/about-record';
import { reconcileGroupDeclaration } from '../src/lib/groups/server/declaration-writer';
import {
	setGroupRules,
	writeAboutAccess,
	writeGroupProfile
} from '../src/lib/groups/server/about-writer';
import {
	groupSpaceReader,
	readGroupAbout,
	rebuildGroupCache
} from '../src/lib/groups/server/about-read';
import { resolveGroupCredential } from '../src/lib/groups/server/credentials';
import { GROUP_SESSION_PREFIX } from '../src/lib/groups/server/linked-session';
import {
	pdsProvisioner,
	provisionGroupSpaces,
	readGroupVisibility,
	setAboutSpaceReadPolicy
} from '../src/lib/groups/server/spaces';
import { groupRebuildSources, rebuildGroup } from '../src/lib/groups/server/rebuild';
import {
	effectivePermissions,
	hasAuthzRecords,
	hasMemberRecords,
	hasRecordedAccess,
	readGroupMembers,
	readGroupSpaceIndex,
	rebuildGroupMembers,
	rosterFromRecords,
	rosterFromRows
} from '../src/lib/groups/server/members-read';
import {
	dropGroupMembership,
	putGroupMembership,
	writeGroupAccess,
	writeGroupAuthz,
	writeGroupSpaceIndex
} from '../src/lib/groups/server/members-writer';
import {
	admitFromRequest,
	admitMember,
	joinGroup,
	ejectMember,
	leaveGroup,
	promoteMember,
	type RosterContext
} from '../src/lib/groups/server/roster';
import { writeMissingAcceptances, type MemberSession } from '../src/lib/groups/server/acceptance';
import { acceptanceGrant } from '../src/lib/groups/server/member-grants';
import { groupAcceptanceReader } from '../src/lib/groups/server/space-credential';

interface Env {
	DB: D1Database;
	/** Where the app looks for the group's linked session, as in production. */
	OAUTH_SESSIONS: KVNamespace;
	/** The stand-in session's login (./groups-e2e.oauth.ts). */
	E2E_GROUP_SERVICE: string;
	E2E_GROUP_IDENTIFIER: string;
	E2E_GROUP_PASSWORD: string;
	/** The admin's login, for the stand-in of their own session (`adminSession`). */
	E2E_ADMIN_PASSWORD: string;
}

type AssignableRole = Exclude<GroupRoleName, 'owner'>;

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

/** The stand-in for the admin's own session, for their acceptance. A sign-in
 *  would carry the group's grant in its scope; a password session needs none at
 *  the PDS, so the scope here is that grant, written out. What it cannot show is
 *  a real sign-in's consent; a walk through a deployed site covers that. */
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
		scope: acceptanceGrant(group.group_did),
		handle: (pathname, init) => {
			const headers = new Headers(init.headers);
			headers.set('authorization', `Bearer ${accessJwt}`);
			return fetch(new URL(pathname, env.E2E_GROUP_SERVICE), { ...init, headers });
		}
	};
}

/** A roster act's context. The driver names the caller on every call, and
 *  `asMember` hands the act the caller's own session, as the join and leave
 *  forms do. */
async function rosterCtx(env: Env, args: Args): Promise<RosterContext> {
	const group = await groupById(env, args.groupId);
	const callerDid = String(args.callerDid);
	return {
		db: env.DB,
		env,
		group,
		callerDid,
		member: args.asMember ? await adminSession(env, callerDid, group) : null
	};
}

/** The group's own space reader. The members space is readable only with the
 *  group's session. */
async function spaceReader(env: Env, group: GroupRow) {
	const reader = await groupSpaceReader(env, env.DB, group);
	if (!reader) throw new Error(`no credential for ${group.group_did}`);
	return reader;
}

const ops: Record<string, (env: Env, args: Args) => Promise<unknown>> = {
	createGroup: (env, args) => createGroup(env.DB, args as never),

	/** Marks the group linked, as its owner's link would. The app finds a linked
	 *  session by this key; restoring it is the stand-in's (./groups-e2e.oauth.ts). */
	linkGroup: async (env, args) => {
		await env.OAUTH_SESSIONS.put(GROUP_SESSION_PREFIX + String(args.groupDid), '{}');
		return { linked: args.groupDid };
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
			await groupSpaceReader(env, env.DB, group)
		);
		const probe = (args.probe as GroupPermission[]) ?? [];
		return {
			did: membership.did,
			role: membership.role,
			status: membership.status,
			pendingRequestId: membership.pendingRequestId,
			permissions: [...membership.permissions].sort(),
			onRoster: membership.onRoster,
			can: Object.fromEntries(probe.map((p) => [p, can(membership.permissions, p)]))
		};
	},

	/** Runs before the spaces exist, so the driver's visibility stands in for the
	 *  host's answer. */
	requestJoin: async (env, args) => {
		const group = await groupById(env, args.groupId);
		return {
			outcome: await requestJoin(
				env.DB,
				group,
				String(args.did),
				(args.message as string | null) ?? null,
				chosenVisibility(args)
			)
		};
	},

	approveJoinRequest: async (env, args) => {
		await approveJoinRequest(
			env.DB,
			String(args.groupId),
			String(args.requestId),
			String(args.deciderDid),
			(args.role as AssignableRole) ?? 'member'
		);
		return { approved: args.requestId };
	},

	changeMemberRole: async (env, args) => {
		await changeMemberRole(
			env.DB,
			String(args.groupId),
			String(args.did),
			args.role as AssignableRole
		);
		return { did: args.did, role: args.role };
	},

	removeMember: async (env, args) => {
		await removeMember(env.DB, String(args.groupId), String(args.did));
		return { removed: args.did };
	},

	/** The write gate. `callerDid` is the person acting; the credential and repo
	 *  are the group's. `record` has the shape atmo's event editor builds. */
	writeGroupEvent: async (env, args) =>
		writeGroupEvent({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			intent: args.intent as 'create' | 'update',
			rkey: args.rkey as string | undefined,
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

	deleteGroupEvent: async (env, args) =>
		deleteGroupEvent({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			rkey: String(args.rkey)
		}),

	/** The index row a mint writes: where the group's repo lives. */
	registerIdentity: async (env, args) =>
		registerGroupIdentity(env.DB, {
			did: String(args.groupDid),
			handle: args.handle == null ? null : String(args.handle),
			pds: String(args.pds)
		}),

	/** The events tab's list, from the app's index and not from the PDS. */
	listGroupEvents: async (env, args) => listGroupEvents(env.DB, await groupById(env, args.groupId)),

	/** The about space and the members space, as a create makes them. Idempotent. */
	provisionSpaces: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const cred = await resolveGroupCredential(env, group.group_did);
		if (!cred) throw new Error(`no credential for ${group.group_did}`);
		const uris = await provisionGroupSpaces(
			pdsProvisioner(cred, group.group_did),
			chosenVisibility(args)
		);
		await recordGroupSpaces(env.DB, group.id, uris);
		return uris;
	},

	writeGroupProfile: async (env, args) =>
		writeGroupProfile({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			visibility: chosenVisibility(args),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			profile: {
				name: String(args.name),
				description: (args.description as string | null) ?? null,
				locationName: (args.locationName as string | null) ?? null,
				createdAt: args.createdAt as string | undefined
			}
		}),

	/** The route's two calls: read the current rules, then reconcile them. */
	setGroupRules: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const reader = await groupSpaceReader(env, env.DB, group);
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
		const reader = await groupSpaceReader(env, env.DB, group);
		if (!reader) throw new Error(`no credential for ${group.group_did}`);
		return readGroupAbout(reader, group);
	},

	rebuildGroupCache: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const reader = await groupSpaceReader(env, env.DB, group);
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

	/** The roster as the members page shows it: the records, each entry marked
	 *  confirmed or not from the acceptances read by DID with the group's
	 *  credential. `confirmed` is null when they could not be read. */
	confirmedRoster: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const members = await readGroupMembers(await spaceReader(env, group), group);
		const dids = members.memberships.map((record) => record.subject);
		const acceptances = await groupAcceptanceReader(env, env.DB, group);
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

	/** The page gate's predicate for one caller. The route module itself cannot be
	 *  bundled here: it pulls in the app's identity resolver, a Svelte module. */
	gate: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const reader = await spaceReader(env, group);
		const [visibility, membership] = await Promise.all([
			readGroupVisibility(reader, group),
			getCallerMembership(env.DB, group, args.did == null ? null : String(args.did), reader)
		]);
		return {
			visibility,
			onRoster: membership.onRoster,
			canSee: canSeeGroup(visibility, membership)
		};
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

	/** The members space's `access` record: who may read the space. */
	writeGroupAccess: async (env, args) =>
		writeGroupAccess({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid)
		}),

	/** The about space's `access` record, saying the visibility the driver passes,
	 *  as create and the settings save write it. */
	writeAboutAccess: async (env, args) =>
		writeAboutAccess({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			visibility: chosenVisibility(args)
		}),

	/** The index of the group's two spaces, read first as the repair reads it. */
	writeSpaceIndex: async (env, args) => {
		const group = await groupById(env, args.groupId);
		return writeGroupSpaceIndex({
			db: env.DB,
			env,
			group,
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			existing: await readGroupSpaceIndex(await spaceReader(env, group), group)
		});
	},

	/** Deletes every index entry through the group's writer. No app path does
	 *  this, but the e2e reuses one DID across runs, and a leftover entry would
	 *  let the index check pass without this run's write. */
	dropSpaceIndex: async (env, args) => {
		const group = await groupById(env, args.groupId);
		if (!group.members_space_uri) return { dropped: [] };
		const writer = await groupWriter(env, env.DB, group);
		const dropped: string[] = [];
		for (const entry of await readGroupSpaceIndex(await spaceReader(env, group), group)) {
			await writer({
				repo: group.group_did,
				collection: GROUP_SPACE_COLLECTION,
				rkey: entry.rkey,
				record: {},
				intent: 'delete',
				space: group.members_space_uri
			});
			dropped.push(entry.rkey);
		}
		return { dropped };
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

	/** The owner's membership record. Other members go through the roster acts. */
	putMembership: async (env, args) =>
		putGroupMembership({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			subject: String(args.did),
			roles: args.roles as GroupRoleName[],
			intent: 'admit'
		}),

	/** Cleanup of the owner's record. The intent is `leave`, because the owner
	 *  cannot be ejected and leaving needs no grant. */
	dropMembership: async (env, args) =>
		dropGroupMembership({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			subject: String(args.did),
			intent: 'leave'
		}),

	/** Deletes the authz config through the group's writer. No app path does this,
	 *  but the e2e reuses one DID across runs. Once a config exists the records
	 *  decide permissions, so a config left after the owner's membership is gone
	 *  leaves the owner with nothing. With no config, the gate reads the rows. */
	dropAuthz: async (env, args) => {
		const group = await groupById(env, args.groupId);
		if (!group.members_space_uri) return { dropped: [] };
		const reader = await spaceReader(env, group);
		const writer = await groupWriter(env, env.DB, group);
		const targets = [
			...(
				await reader.list({
					space: group.members_space_uri,
					repo: group.group_did,
					collection: GROUP_ROLE_COLLECTION
				})
			).map((r) => ({ collection: GROUP_ROLE_COLLECTION, rkey: r.rkey })),
			{ collection: GROUP_PERMISSIONS_COLLECTION, rkey: GROUP_PERMISSIONS_RKEY },
			{ collection: GROUP_EVENT_PERMISSIONS_COLLECTION, rkey: GROUP_PERMISSIONS_RKEY }
		];
		const dropped: string[] = [];
		for (const target of targets) {
			const present = await reader.get({
				space: group.members_space_uri,
				repo: group.group_did,
				...target
			});
			if (!present) continue;
			await writer({
				repo: group.group_did,
				...target,
				record: {},
				intent: 'delete',
				space: group.members_space_uri
			});
			dropped.push(`${target.collection}/${target.rkey}`);
		}
		return { dropped };
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
			`SELECT m.did, r.name AS role, m.status, m.created_at FROM memberships m
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
		const sources = await groupRebuildSources(env, env.DB, groupDid);
		if (!sources) throw new Error(`no credential for ${groupDid}`);
		return rebuildGroup(env.DB, sources, groupDid);
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

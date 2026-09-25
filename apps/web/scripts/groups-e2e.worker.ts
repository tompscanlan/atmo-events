// The in-runtime half of `scripts/groups-e2e.mjs`.
//
// The groups layer is Worker code: D1 for the group facts, outbound PDS writes
// for the group's records. So the e2e runs it on workerd with a real D1 binding,
// rather than importing it into Node. This file is the entry Vite bundles for
// that runtime. It is kept thin on purpose: it holds no rule and no assertion.
// Every decision it returns is made by the $lib/groups modules it imports; this
// is a JSON door onto them.
//
// The driver sends one request per operation through Miniflare's
// `dispatchFetch`, which needs no socket. Miniflare's D1 proxy
// (`getD1Database`) goes through a loopback proxy that can hang in some dev
// containers.
//
// Not deployed, not routed, never imported by the app. `scripts/` is outside
// tsconfig's include, like scripts/geocode-events.ts.
import { can, type GroupPermission } from '../src/lib/groups/permissions';
import type { GroupRoleName } from '../src/lib/groups/permissions';
import type { GroupRow } from '../src/lib/groups/types';
import { groupEventRecord, type GroupEventFormInput } from '../src/lib/groups/event-record';
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
	writeGroupEvent
} from '../src/lib/groups/server/event-writer';
import {
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION
} from '../src/lib/groups/members-record';
import { listGroupEvents, registerGroupIdentity } from '../src/lib/groups/server/events-index';
import { splitRuleLines } from '../src/lib/groups/about-record';
import { reconcileGroupDeclaration } from '../src/lib/groups/server/declaration-writer';
import { setGroupRules, writeGroupProfile } from '../src/lib/groups/server/about-writer';
import {
	groupSpaceReader,
	readGroupAbout,
	rebuildGroupCache
} from '../src/lib/groups/server/about-read';
import { resolveGroupCredential, storeGroupCredential } from '../src/lib/groups/server/credentials';
import { ensureGroupsSchema } from '../src/lib/groups/server/schema';
import { pdsProvisioner, provisionGroupSpaces } from '../src/lib/groups/server/spaces';
import { groupRebuildSources, rebuildGroup } from '../src/lib/groups/server/rebuild';
import {
	effectivePermissions,
	hasAuthzRecords,
	hasMemberRecords,
	hasRecordedAccess,
	readGroupMembers,
	rebuildGroupMembers,
	rosterFromRecords,
	rosterFromRows
} from '../src/lib/groups/server/members-read';
import {
	dropGroupMembership,
	putGroupMembership,
	writeGroupAccess,
	writeGroupAuthz
} from '../src/lib/groups/server/members-writer';
import {
	admitMember,
	ejectMember,
	promoteMember,
	type RosterContext
} from '../src/lib/groups/server/roster';

interface Env {
	DB: D1Database;
	/** AES-GCM key for the group's app password in D1. It is the same binding
	 *  production uses, because the encrypted row is the only credential
	 *  source. */
	GROUP_CREDENTIAL_KEY?: string;
}

type AssignableRole = Exclude<GroupRoleName, 'owner'>;

/** Args are already-parsed JSON from the driver, which is the only caller. */
type Args = Record<string, unknown>;

async function groupById(env: Env, groupId: unknown): Promise<GroupRow> {
	const row = await getGroupById(env.DB, String(groupId));
	if (!row) throw new Error(`no group ${String(groupId)} in D1`);
	return row;
}

/** The context a roster act takes. The driver names the caller on every call,
 *  because who is asking is half of what these ops test. */
async function rosterCtx(env: Env, args: Args): Promise<RosterContext> {
	return {
		db: env.DB,
		env,
		group: await groupById(env, args.groupId),
		callerDid: String(args.callerDid)
	};
}

/** The group's own space reader, or a loud failure. Every roster read below
 *  goes through it, because these records are readable only with the group's
 *  own session. */
async function spaceReader(env: Env, group: GroupRow) {
	const reader = await groupSpaceReader(env, env.DB, group);
	if (!reader) throw new Error(`no credential for ${group.group_did}`);
	return reader;
}

const ops: Record<string, (env: Env, args: Args) => Promise<unknown>> = {
	createGroup: (env, args) => createGroup(env.DB, args as never),

	/** Seeds the fixture group's credential the way a mint would, so this run
	 *  authenticates through the same encrypted row production reads. The mint
	 *  runs after `createGroup` has built the schema; this runs first, so it
	 *  builds it itself. */
	storeCredential: async (env, args) => {
		await ensureGroupsSchema(env.DB);
		await storeGroupCredential(env, env.DB, String(args.groupDid), {
			service: String(args.service),
			identifier: String(args.identifier),
			password: String(args.password)
		});
		return { stored: args.groupDid };
	},

	/** Stored bundles, as rows: the seeded data, not the constant it came from. */
	rolePermissions: (env, args) => rolePermissions(env.DB, String(args.groupId)),

	listMembers: (env, args) => listMembers(env.DB, String(args.groupId)),

	listJoinRequests: (env, args) =>
		listJoinRequests(env.DB, String(args.groupId), (args.status as 'pending' | 'all') ?? 'pending'),

	/** The permission resolver's answer, plus `can()` for each probed name so the
	 *  gate the app actually asks is the thing asserted. */
	membership: async (env, args) => {
		// The app's own loader, reader included: once the members space holds an
		// authz config, this answer comes from the records, not the rows.
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

	requestJoin: async (env, args) => ({
		outcome: await requestJoin(
			env.DB,
			await groupById(env, args.groupId),
			String(args.did),
			(args.message as string | null) ?? null
		)
	}),

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

	/** The write gate. `callerDid` is the person pressing the button; the
	 *  credential is the group's, and `repo` is the group DID (see
	 *  event-writer.ts).
	 *
	 *  `form` is the form's fields, not a record. The record is built by the
	 *  same $lib/groups/event-record.ts the route uses, so the shape asserted
	 *  here is the shape an organizer's submission produces. */
	writeGroupEvent: async (env, args) =>
		writeGroupEvent({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			intent: args.intent as 'create' | 'update',
			rkey: args.rkey as string | undefined,
			record: groupEventRecord(args.form as GroupEventFormInput)
		}),

	deleteGroupEvent: async (env, args) =>
		deleteGroupEvent({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			rkey: String(args.rkey)
		}),

	/** The index row a mint writes. This run binds an existing DID through
	 *  `createGroup`, which mints nothing, so the fact `runCreateGroup` records
	 *  at mint (where this group's repo lives) is recorded here instead,
	 *  through the same function. */
	registerIdentity: async (env, args) =>
		registerGroupIdentity(env.DB, {
			did: String(args.groupDid),
			handle: args.handle == null ? null : String(args.handle),
			pds: String(args.pds)
		}),

	/** What the events tab renders: the group's public events as the app's own
	 *  index holds them, not as the PDS hands them back. */
	listGroupEvents: async (env, args) => listGroupEvents(env.DB, await groupById(env, args.groupId)),

	/** Both spaces the fixture group needs: the about space for its profile and
	 *  the members space for its roster. The e2e binds an existing DID through
	 *  `createGroup`, which provisions nothing (only `runCreateGroup` does), so
	 *  they are made here. Idempotent, like the create path's own call. */
	provisionSpaces: async (env, args) => {
		const group = await groupById(env, args.groupId);
		const cred = await resolveGroupCredential(env, env.DB, group.group_did);
		if (!cred) throw new Error(`no credential for ${group.group_did}`);
		const uris = await provisionGroupSpaces(pdsProvisioner(cred, group.group_did));
		await recordGroupSpaces(env.DB, group.id, uris);
		return uris;
	},

	writeGroupProfile: async (env, args) =>
		writeGroupProfile({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			profile: {
				name: String(args.name),
				description: (args.description as string | null) ?? null,
				locationName: (args.locationName as string | null) ?? null,
				createdAt: args.createdAt as string | undefined
			}
		}),

	/** The route's own composition: read the current rules, then reconcile. The
	 *  reconcile rule (keep an unchanged rule's rkey) lives in about-writer.ts;
	 *  this door only makes the same two calls the form makes. */
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

	/** Overwrites every column the profile record owns, so the rebuild has
	 *  something to repair. Through the app's own updater rather than raw SQL:
	 *  a corruption the app could not itself produce would prove nothing. */
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

	/** The members space's `access` record: who may read the space.
	 *  `runCreateGroup` writes it at create. This fixture binds an existing DID
	 *  instead of running create, so the driver writes it the same way. */
	writeGroupAccess: async (env, args) =>
		writeGroupAccess({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid)
		}),

	/** The one record a stranger can read, and the only door here that changes
	 *  what the anonymous web sees. Visibility is changed first through the
	 *  app's own `updateGroup` (the same call the settings form makes), so the
	 *  branch this exercises is taken from the row, as in production, rather
	 *  than from an argument the harness made up. */
	reconcileDeclaration: async (env, args) => {
		if (args.visibility !== undefined) {
			await updateGroup(env.DB, String(args.groupId), {
				visibility: args.visibility as GroupRow['visibility']
			});
		}
		const result = await reconcileGroupDeclaration({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			createdAt: args.createdAt as string | undefined
		});
		return { uri: result?.uri ?? null };
	},

	/** The authz config: one `role` record per seeded role and the two binding
	 *  records. Written here for the same reason as the access record: create
	 *  writes it, and this fixture binds an existing DID instead. */
	writeGroupAuthz: async (env, args) =>
		writeGroupAuthz({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			bundles: args.bundles as Record<GroupRoleName, GroupPermission[]> | undefined
		}),

	/** The authz config as the records say it is, plus the effective grant for
	 *  one role. That grant is the union across both binding records, which a
	 *  reader of only `permissions` would get wrong. */
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

	/** The owner's membership record, for the same reason: only the create path
	 *  writes it. Every other membership below goes through a roster act
	 *  (`server/roster.ts`), which is what the app's own handlers call. */
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

	/** Its counterpart, for cleanup: the owner's own record. The intent is
	 *  `leave` because the caller is the subject: the owner cannot be ejected,
	 *  and removing your own membership needs no grant. */
	dropMembership: async (env, args) =>
		dropGroupMembership({
			db: env.DB,
			env,
			group: await groupById(env, args.groupId),
			callerDid: args.callerDid == null ? null : String(args.callerDid),
			subject: String(args.did),
			intent: 'leave'
		}),

	/** Fixture teardown for the authz config: every `role` record and both
	 *  binding records, deleted directly through the group's writer. No app
	 *  path removes a config (a group keeps one for life), but this fixture
	 *  reuses one DID across runs. A config left behind after the owner's
	 *  membership is gone is a space in which the owner holds nothing, because
	 *  the records decide permissions once a config exists. Emptying it returns
	 *  the space to "no config yet", where the gate reads the rows. A record
	 *  that is already absent is not an error. */
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

	/** Row plus record, in the app's own order. These are exactly what the
	 *  remote handlers call, so the e2e tests the composition the app ships,
	 *  not a copy of it. */
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

	/** The roster as the members page builds it: records when the space holds
	 *  any, the cache otherwise. Also the access answer for one DID, which
	 *  checks that a member with no membership record has no access. */
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

	/** Drops the roster cache. Raw SQL, unlike `corruptGroupCache`, because no
	 *  app path deletes roster rows in bulk. The owner's row is exempt in any
	 *  case: `memberships_owner_undeletable` refuses to delete it while the
	 *  group exists, so the rebuild this sets up is tested on the non-owner
	 *  rows. (A group with no rows at all is the cold rebuild, `rebuildGroup`
	 *  below.) */
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

	/** Everything a rebuild must restore, keyed by DID so it can be read before
	 *  and after the row's id changes: the row, the roster with roles, and each
	 *  role's bundle. */
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

	/** Deletes the group row, and with it (ON DELETE CASCADE) its roles,
	 *  bundles, roster and join requests. `group_credentials` is keyed by DID
	 *  and survives; it is the one row a rebuild starts from. */
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

/** Refusals are the point of half these calls, so they travel as data: the
 *  class name and the machine-readable tag the app routes on, never a string
 *  the driver would have to pattern-match. */
function serialiseError(error: unknown) {
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
		if (!run) return json({ ok: false, error: serialiseError(new Error(`unknown op ${op}`)) }, 400);

		try {
			return json({ ok: true, value: await run(env, args ?? ({} as Args)) });
		} catch (error) {
			return json({ ok: false, error: serialiseError(error) });
		}
	}
};

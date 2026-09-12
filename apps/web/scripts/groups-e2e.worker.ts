// The in-runtime half of `scripts/groups-e2e.mjs`.
//
// The groups layer is Worker code: D1 for the group facts, an outbound PDS
// write for the group's calendar records. So the e2e runs it ON workerd, with a
// real D1 binding, rather than importing it into Node and hoping the two agree.
// This file is the ENTRY that Vite bundles for that runtime — deliberately
// thin: it owns no rule, no assertion and no story. Every decision it returns
// is made by $lib/groups/server/{repo,event-writer}.ts and
// $lib/groups/permissions.ts; this is a JSON door onto them.
//
// Why a door at all: Miniflare's magic proxy (`getD1Database`) never answers in
// this dev container — the same loopback/proxy layer that makes `wrangler dev`
// hang here — while `dispatchFetch` is fine. So the driver talks to the modules
// by dispatching one request per operation.
//
// Not deployed, not routed, never imported by the app. `scripts/` is outside
// tsconfig's include, exactly like scripts/geocode-events.ts.
import { can, type GroupPermission } from '../src/lib/groups/permissions';
import type { GroupRoleName } from '../src/lib/groups/permissions';
import type { GroupRow } from '../src/lib/groups/types';
import { groupEventRecord, type GroupEventFormInput } from '../src/lib/groups/event-record';
import {
	approveJoinRequest,
	changeMemberRole,
	createGroup,
	getCallerMembership,
	getGroupById,
	listJoinRequests,
	listMembers,
	removeMember,
	requestJoin,
	rolePermissions
} from '../src/lib/groups/server/repo';
import { deleteGroupEvent, writeGroupEvent } from '../src/lib/groups/server/event-writer';

interface Env {
	DB: D1Database;
	/** The group's custodial credential, in the shape the app's own secret has. */
	GROUP_CREDENTIALS?: string;
}

type AssignableRole = Exclude<GroupRoleName, 'owner'>;

/** Args are already-parsed JSON from the driver, which is the only caller. */
type Args = Record<string, unknown>;

async function groupById(env: Env, groupId: unknown): Promise<GroupRow> {
	const row = await getGroupById(env.DB, String(groupId));
	if (!row) throw new Error(`no group ${String(groupId)} in D1`);
	return row;
}

const ops: Record<string, (env: Env, args: Args) => Promise<unknown>> = {
	createGroup: (env, args) => createGroup(env.DB, args as never),

	/** Stored bundles, as rows — the seeded data, not the constant it came from. */
	rolePermissions: (env, args) => rolePermissions(env.DB, String(args.groupId)),

	listMembers: (env, args) => listMembers(env.DB, String(args.groupId)),

	listJoinRequests: (env, args) =>
		listJoinRequests(env.DB, String(args.groupId), (args.status as 'pending' | 'all') ?? 'pending'),

	/** The permission resolver's answer, plus `can()` for each probed name so the
	 *  gate the app actually asks is the thing asserted. */
	membership: async (env, args) => {
		const membership = await getCallerMembership(
			env.DB,
			String(args.groupId),
			args.did == null ? null : String(args.did)
		);
		const probe = (args.probe as GroupPermission[]) ?? [];
		return {
			did: membership.did,
			role: membership.role,
			status: membership.status,
			pendingRequestId: membership.pendingRequestId,
			permissions: [...membership.permissions].sort(),
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

	/** THE GATE. `callerDid` is the human pressing the button; the credential is
	 *  the group's, and `repo` is the group DID — see event-writer.ts.
	 *
	 *  `form` is the FORM's fields, not a record: the record is built by the same
	 *  $lib/groups/event-record.ts the route uses, so the shape asserted here is
	 *  the shape an organizer's submission produces. */
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
		})
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

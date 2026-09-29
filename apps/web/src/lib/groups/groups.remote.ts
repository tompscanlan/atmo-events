// Every group mutation, as SvelteKit remote `form` functions. Reads stay in
// the routes' `+page.server.ts` loads.
//
// Every handler resolves the group by DID, resolves the caller's membership,
// asks `can()`, then acts. `locals.did` is only the subject of that check:
// group events are authored by the group's own DID (./server/event-writer.ts).
import { error } from '@sveltejs/kit';
import { command, form, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { ASSIGNABLE_ROLES, can } from './permissions';
import type { GroupFormFailure, GroupFormResult } from './form-result';
import { formError, notAllowed } from './form-error';
// Not declared here: the Vite plugin rejects non-remote exports from a
// `*.remote.ts`, so a field that a test needs lives in ./form-fields.ts.
import { checkboxField, memberActorField, shownVisibilityField } from './form-fields';
import { runCreateGroup, type CreateGroupOutcome } from './create-group';
import { runUpdateGroup } from './update-group';
import { GROUP_LABEL_PATTERN } from './handle-label';
import {
	GROUP_VISIBILITIES,
	type CallerMembership,
	type GroupRow,
	type GroupVisibility
} from './types';
import { searchPeopleByHandle } from './server/people-search';
import { decideJoinRequest, type JoinOutcome } from './server/repo';
import { groupActorToDid, groupRouteContext } from './server/route-context';
import {
	GROUP_EVENT_IMAGE_MAX_BYTES,
	deleteGroupEvent,
	uploadGroupEventImage,
	writeGroupEvent,
	type GroupBlobRef
} from './server/event-writer';
import { describeRepair, repairGroup } from './server/repair';
// ./server/roster.ts is shared with the e2e harness, so both run the same sequence.
import {
	RosterListError,
	RosterRecordError,
	RosterRowError,
	admitFromRequest,
	admitMember,
	ejectMember,
	joinGroup,
	leaveGroup,
	promoteMember
} from './server/roster';
import { GroupSpaceError } from './server/spaces';

/** The group key every form posts, and the subject DID on the roster forms.
 *  `context` also accepts a full handle, but the app's forms post the DID. */
const didField = v.pipe(v.string(), v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,300}$/, 'Invalid DID'));
/** Shape only. `runCreateGroup` applies the stricter rules for a new label
 *  (`labelMintRefusal`). */
const labelField = v.pipe(v.string(), v.regex(GROUP_LABEL_PATTERN, 'Invalid group handle label'));
const idField = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
/** No `owner`: a SQL trigger pins it to `groups.owner_did`. A picklist, not a
 *  `v.check`, so the output type is the role union the repo calls take. */
const assignableRoleField = v.picklist(ASSIGNABLE_ROLES, 'Unknown role');

/** What every handler resolves before it acts: the bindings, the group, and the
 *  caller's standing in it. */
interface GroupRequestContext {
	db: D1Database;
	env: App.Platform['env'];
	group: GroupRow;
	membership: CallerMembership;
	/** The host's visibility, when the gate asked. The join refusal reads it. */
	visibility: GroupVisibility | null;
	/** Never null: `context` throws 401 before returning. */
	callerDid: string;
}

/** Throws 401 when not signed in, and the route's own 404 for every other
 *  refusal. It uses the pages' lookup (`server/route-context.ts`): anyone
 *  signed in can POST a remote form with any group key, so a separate lookup
 *  could reveal that a private group exists. */
async function context(actor: string): Promise<GroupRequestContext> {
	const { locals, platform } = getRequestEvent();
	if (!locals.did) error(401, 'Sign in to do that');
	const db = platform!.env.DB;
	const { group, membership, visibility } = await groupRouteContext(
		platform!.env,
		db,
		actor,
		locals.did
	);
	return { db, env: platform!.env, group, membership, visibility, callerDid: locals.did };
}

export const createGroupForm = form(
	v.object({
		name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
		label: labelField,
		description: v.optional(v.pipe(v.string(), v.maxLength(4000))),
		visibility: v.picklist(GROUP_VISIBILITIES),
		requireApproval: checkboxField,
		locationName: v.optional(v.pipe(v.string(), v.maxLength(200))),
		rules: v.optional(v.pipe(v.string(), v.maxLength(8000)))
	}),
	async (data): Promise<CreateGroupOutcome> => {
		const { locals, platform } = getRequestEvent();
		if (!locals.did) error(401, 'Sign in to create a group');
		// No redirect: the result carries the owner's rotation key, which is shown
		// once and stored nowhere, so a 303 would lose it.
		return runCreateGroup(platform!.env, locals.did, data);
	}
);

export const updateGroupForm = form(
	v.object({
		groupDid: didField,
		name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
		description: v.optional(v.pipe(v.string(), v.maxLength(4000))),
		visibility: v.picklist(GROUP_VISIBILITIES),
		/** What the form showed, so the save can tell a change from a stale default. */
		shownVisibility: shownVisibilityField,
		requireApproval: checkboxField,
		rules: v.optional(v.pipe(v.string(), v.maxLength(8000)))
	}),
	async (data): Promise<GroupFormResult> => {
		const { db, env, group, membership, callerDid } = await context(data.groupDid);
		if (!can(membership.permissions, 'MANAGE_GROUP')) {
			return notAllowed(membership, 'MANAGE_GROUP');
		}
		return runUpdateGroup(env, db, group, callerDid, data);
	}
);

/** Repairs a group whose records and this site's copy no longer agree
 *  (./server/repair.ts). Needs MANAGE_GROUP. */
export const repairGroupForm = form(
	v.object({ groupDid: didField }),
	async (data): Promise<GroupFormResult<{ summary: string }>> => {
		const { db, env, group, membership, callerDid } = await context(data.groupDid);
		if (!can(membership.permissions, 'MANAGE_GROUP')) {
			return notAllowed(membership, 'MANAGE_GROUP');
		}
		try {
			const result = await repairGroup({ db, env, group, callerDid });
			return { ok: true, summary: describeRepair(result) };
		} catch (e) {
			try {
				return formError(e);
			} catch {
				// The PDS or the database failed partway. Every repair write is
				// checked first, so a second run continues from there.
				return {
					ok: false,
					error: `The repair stopped partway: ${
						e instanceof Error ? e.message : String(e)
					}. Anything it wrote is kept, and running it again continues from there.`
				};
			}
		}
	}
);

/** Maps a roster failure to a form result. The three roster errors mean a
 *  later half of the act failed after an earlier half took effect
 *  (`server/roster.ts`), so the message says what is out of step. Returns the
 *  failure only, so it also fits a handler whose success carries a payload. */
function rosterFailure(e: unknown): GroupFormFailure {
	if (e instanceof RosterListError) {
		return {
			ok: false,
			error:
				e.change === 'grant'
					? `${e.subject} is on the roster, but was not added to the group's member list at its PDS: ${e.message}. "Repair this group" in the group's settings adds them.`
					: `${e.subject} can no longer read the group at its PDS, but their membership was not removed: ${e.message}. Removing them again finishes it.`
		};
	}
	if (e instanceof RosterRecordError) {
		return {
			ok: false,
			error: `The roster was updated, but the membership record for ${e.subject} was not: ${e.message}`
		};
	}
	if (e instanceof RosterRowError) {
		return {
			ok: false,
			error: `Access was revoked for ${e.subject}, but the roster still lists them: ${e.message}`
		};
	}
	// A revocation's first write, the member-list removal, was refused.
	if (e instanceof GroupSpaceError) {
		return {
			ok: false,
			error: `The group's PDS did not accept the change, so nothing was changed: ${e.message}. Try again.`
		};
	}
	return formError(e);
}

export const joinGroupForm = form(
	v.object({
		groupDid: didField,
		message: v.optional(v.pipe(v.string(), v.maxLength(1000)))
	}),
	async (data): Promise<GroupFormResult<{ outcome: JoinOutcome }>> => {
		const ctx = await context(data.groupDid);
		try {
			return { ok: true, outcome: await joinGroup(ctx, data.message || null) };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);

/** Leave, or withdraw a pending request: one button, since for the applicant
 *  they are the same intent. The owner cannot leave (a GroupRuleError). */
export const leaveGroupForm = form(
	v.object({ groupDid: didField }),
	async (data): Promise<GroupFormResult<{ outcome: 'withdrawn' | 'left' }>> => {
		const ctx = await context(data.groupDid);
		try {
			// A pending applicant has no record, so only `join_requests` changes.
			if (ctx.membership.pendingRequestId) {
				await decideJoinRequest(
					ctx.db,
					ctx.group.id,
					ctx.membership.pendingRequestId,
					ctx.callerDid,
					'withdrawn'
				);
				return { ok: true, outcome: 'withdrawn' };
			}
			await leaveGroup(ctx);
			return { ok: true, outcome: 'left' };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);

export const approveJoinRequestForm = form(
	v.object({
		groupDid: didField,
		requestId: idField,
		role: v.optional(assignableRoleField)
	}),
	async (data): Promise<GroupFormResult> => {
		const ctx = await context(data.groupDid);
		if (!can(ctx.membership.permissions, 'ADMIT_MEMBERS')) {
			return notAllowed(ctx.membership, 'ADMIT_MEMBERS');
		}
		try {
			await admitFromRequest(ctx, data.requestId, data.role ?? 'member');
			return { ok: true };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);

export const rejectJoinRequestForm = form(
	v.object({ groupDid: didField, requestId: idField }),
	async (data): Promise<GroupFormResult> => {
		const { db, group, membership, callerDid } = await context(data.groupDid);
		if (!can(membership.permissions, 'ADMIT_MEMBERS')) {
			return notAllowed(membership, 'ADMIT_MEMBERS');
		}
		try {
			// A rejected request never granted anything, so there is no record.
			await decideJoinRequest(db, group.id, data.requestId, callerDid, 'rejected');
			return { ok: true };
		} catch (e) {
			return formError(e);
		}
	}
);

/** Adds a known DID without a request. Same gate as approving one. */
/** Takes a handle or a DID. A handle is resolved here, after the permission
 *  check, and the DID it resolves to is what the roster records. */
export const addMemberForm = form(
	v.object({ groupDid: didField, actor: memberActorField, role: v.optional(assignableRoleField) }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await context(data.groupDid);
		if (!can(ctx.membership.permissions, 'ADMIT_MEMBERS')) {
			return notAllowed(ctx.membership, 'ADMIT_MEMBERS');
		}
		let did: string;
		if ('did' in data.actor) {
			did = data.actor.did;
		} else {
			// Null for an unknown handle and for a resolver outage alike.
			const resolved = await groupActorToDid(data.actor.handle);
			if (!resolved) {
				return {
					ok: false,
					error: `Could not resolve ${data.actor.handle} to an account. Check the handle, or enter the DID.`
				};
			}
			did = resolved;
		}
		try {
			await admitMember(ctx, did, data.role ?? 'member');
			return { ok: true };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);

/** Handle suggestions for the add-member form, from this deployment's own index
 *  (./server/people-search.ts). Signed-in callers only; the form itself still
 *  checks ADMIT_MEMBERS. */
export const suggestPeople = command(v.pipe(v.string(), v.maxLength(253)), async (prefix) => {
	const { locals, platform } = getRequestEvent();
	if (!locals.did) return [];
	return searchPeopleByHandle(platform!.env.DB, prefix);
});

export const removeMemberForm = form(
	v.object({ groupDid: didField, did: didField }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await context(data.groupDid);
		if (!can(ctx.membership.permissions, 'EJECT_MEMBERS')) {
			return notAllowed(ctx.membership, 'EJECT_MEMBERS');
		}
		try {
			await ejectMember(ctx, data.did);
			return { ok: true };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);

export const changeMemberRoleForm = form(
	v.object({ groupDid: didField, did: didField, role: assignableRoleField }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await context(data.groupDid);
		if (!can(ctx.membership.permissions, 'ASSIGN_ROLES')) {
			return notAllowed(ctx.membership, 'ASSIGN_ROLES');
		}
		try {
			await promoteMember(ctx, data.did, data.role);
			return { ok: true };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);

const rkeyField = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/, 'Invalid record key'));
const eventIntentField = v.picklist(['create', 'update'] as const);

// The group's side of atmo's event editor (./editor-adapter.ts). The editor
// builds the record; these write it as the group. The writer checks the
// permission from a fresh membership read (CREATE_EVENT for a create,
// MANAGE_EVENTS otherwise) and the record against the event lexicon.

/** Create or edit a group event, authored by the group DID. */
export const putGroupEvent = command(
	v.object({
		groupDid: didField,
		rkey: rkeyField,
		intent: eventIntentField,
		record: v.record(v.string(), v.unknown())
	}),
	async (data): Promise<GroupFormResult<{ uri: string }>> => {
		const { db, env, group, callerDid } = await context(data.groupDid);
		try {
			const result = await writeGroupEvent({
				db,
				env,
				group,
				callerDid,
				intent: data.intent,
				rkey: data.rkey,
				record: data.record
			});
			return { ok: true, uri: result.uri };
		} catch (e) {
			return formError(e);
		}
	}
);

export const removeGroupEvent = command(
	v.object({ groupDid: didField, rkey: rkeyField }),
	async (data): Promise<GroupFormResult<{ uri: string }>> => {
		const { db, env, group, callerDid } = await context(data.groupDid);
		try {
			const result = await deleteGroupEvent({ db, env, group, callerDid, rkey: data.rkey });
			return { ok: true, uri: result.uri };
		} catch (e) {
			return formError(e);
		}
	}
);

/** An event's cover image, uploaded into the group's repo so the group's
 *  record can cite it. Bytes as a number array, as atmo's own upload sends them. */
export const putGroupEventImage = command(
	v.object({
		groupDid: didField,
		intent: eventIntentField,
		bytes: v.pipe(v.array(v.number()), v.maxLength(GROUP_EVENT_IMAGE_MAX_BYTES)),
		mimeType: v.pipe(v.string(), v.maxLength(100))
	}),
	async (data): Promise<GroupFormResult<{ blob: GroupBlobRef }>> => {
		const { db, env, group, callerDid } = await context(data.groupDid);
		try {
			const blob = await uploadGroupEventImage({
				db,
				env,
				group,
				callerDid,
				intent: data.intent,
				bytes: new Uint8Array(data.bytes),
				mimeType: data.mimeType
			});
			return { ok: true, blob };
		} catch (e) {
			return formError(e);
		}
	}
);

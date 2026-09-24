// Every group mutation, as SvelteKit remote `form` functions — the house style
// for writes in this app ($lib/atproto/server/repo.remote.ts,
// $lib/contrail/events.remote.ts). Reads stay in the routes' `+page.server.ts`
// loads.
// Shape of every handler: resolve the group by DID, resolve the CALLER's
// membership, ask `can()`, then act. `locals.did` is only ever the subject of
// that check — group events are authored by the group's own DID (see
// ./server/event-writer.ts).
import { error } from '@sveltejs/kit';
import { form, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { ASSIGNABLE_ROLES, can } from './permissions';
import type { GroupFormFailure, GroupFormResult } from './form-result';
import { formError } from './form-error';
// Not declared here: the Vite plugin rejects non-remote exports from a
// `*.remote.ts`, so a field a test has to reach lives in ./form-fields.ts.
import { checkboxField } from './form-fields';
import { runCreateGroup } from './create-group';
import { GROUP_LABEL_PATTERN } from './handle-label';
import { GROUP_VISIBILITIES, type CallerMembership, type GroupRow } from './types';
import { decideJoinRequest, updateGroup, type JoinOutcome } from './server/repo';
import { groupRouteContext } from './server/route-context';
import { deleteGroupEvent, groupWriter, writeGroupEvent } from './server/event-writer';
import { splitRuleLines } from './about-record';
import { groupSpaceReader, readGroupAbout } from './server/about-read';
import { setGroupRules, writeGroupProfile } from './server/about-writer';
import { reconcileGroupDeclaration } from './server/declaration-writer';
// Every roster act is a row move PLUS a record write, composed once in
// ./server/roster.ts so the app and the e2e harness drive the same sequence.
import {
	RosterRecordError,
	RosterRowError,
	admitFromRequest,
	admitMember,
	ejectMember,
	joinGroup,
	leaveGroup,
	promoteMember
} from './server/roster';
import { groupEventRecord } from './event-record';

/** THE GROUP KEY every form posts. A group is addressed by its DID: there is no
 *  slug to post and no name to be unique (FR-010a). `context` accepts a full
 *  handle too, because the resolver the pages use is the same one — but the app
 *  never renders a form carrying anything but the DID. Doubles as the SUBJECT
 *  field on the roster forms, which have always taken a DID. */
const didField = v.pipe(v.string(), v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,300}$/, 'Invalid DID'));
/** The create form's handle label — the one string a group reserves anywhere.
 *  Shape only; `labelMintRefusal` inside `runCreateGroup` is what a NEW label is
 *  held to, and it reports on the field the user can edit (FR-001d). */
const labelField = v.pipe(v.string(), v.regex(GROUP_LABEL_PATTERN, 'Invalid group handle label'));
const idField = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
/** `owner` is deliberately absent: it is pinned to `groups.owner_did` by SQL
 *  trigger, so accepting it here would only produce a constraint error. A
 *  picklist rather than a `v.check` predicate because the picklist's OUTPUT is
 *  the role union — a `check` leaves it `string`, and every repo call below
 *  takes a role, not a string. */
const assignableRoleField = v.picklist(ASSIGNABLE_ROLES, 'Unknown role');

/** The address lexicon's own constraint (country is 2..10 chars), so a bad code
 *  is refused with a message the form can show rather than surfacing later as
 *  "that is not a valid community.lexicon.calendar.event record". An EMPTY
 *  field means "no country", which is not an error — it means no address entry
 *  is written (see ./event-record.ts). */
const countryField = v.pipe(
	v.string(),
	v.trim(),
	v.check(
		(value) => value === '' || (value.length >= 2 && value.length <= 10),
		'Country must be an ISO code, 2 to 10 characters'
	)
);

/** What every handler resolves before it acts: the bindings, the group, and the
 *  caller's standing in it. Named rather than inferred so the two helpers below
 *  can take it as a parameter. */
interface GroupRequestContext {
	db: D1Database;
	env: App.Platform['env'];
	group: GroupRow;
	membership: CallerMembership;
	/** Never null: `context` throws 401 before returning. */
	callerDid: string;
}

/** The three things every handler needs, plus the caller's resolved
 *  permissions. Throws 401 when not signed in, and the ROUTE's own 404 for
 *  every other refusal.
 *
 *  IT IS THE SAME FUNCTION THE PAGES USE — `server/route-context.ts` — so a
 *  form cannot disagree with the page it was posted from. That matters more
 *  here than anywhere else: a remote `form()` is an addressable POST bound to
 *  nothing but sign-in and the group key, so a handler with its own lookup was
 *  a private group's existence oracle (om-5oxc8). It takes a DID or a full
 *  handle for the same reason the pages do, though every form the app renders
 *  posts the DID. */
async function context(actor: string): Promise<GroupRequestContext> {
	const { locals, platform } = getRequestEvent();
	if (!locals.did) error(401, 'Sign in to do that');
	const db = platform!.env.DB;
	const { group, membership } = await groupRouteContext(platform!.env, db, actor, locals.did);
	return { db, env: platform!.env, group, membership, callerDid: locals.did };
}

export const createGroupForm = form(
	v.object({
		name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
		/** The HANDLE LABEL, not a stored name: it is the leaf the mint registers
		 *  under `GROUP_HANDLE_DOMAIN`, and the PDS's handle registry is what
		 *  adjudicates it. Nothing keeps a copy (FR-001a). */
		label: labelField,
		description: v.optional(v.pipe(v.string(), v.maxLength(4000))),
		visibility: v.picklist(GROUP_VISIBILITIES),
		requireApproval: checkboxField,
		// No `spaceUri` field: the group's two spaces are CREATED here now, not
		// bound to a string someone pasted in.
		locationName: v.optional(v.pipe(v.string(), v.maxLength(200))),
		/** No column behind this one: the rule RECORDS are the only copy. */
		rules: v.optional(v.pipe(v.string(), v.maxLength(8000)))
	}),
	async (
		data
	): Promise<GroupFormResult<{ groupDid: string; handle: string; recoveryKey: string }>> => {
		const { locals, platform } = getRequestEvent();
		if (!locals.did) error(401, 'Sign in to create a group');
		// NO REDIRECT on success. The owner's rotation key comes back in the
		// result, is shown exactly once and is stored nowhere on our side, so a
		// 303 here would destroy it. The page renders it, then links onward. The
		// ordered flow — and every way it can fail — is ./create-group.ts.
		// (Spec: FR-001g.)
		return runCreateGroup(platform!.env, locals.did, data);
	}
);

export const updateGroupForm = form(
	v.object({
		groupDid: didField,
		name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
		description: v.optional(v.pipe(v.string(), v.maxLength(4000))),
		visibility: v.picklist(GROUP_VISIBILITIES),
		requireApproval: checkboxField,
		rules: v.optional(v.pipe(v.string(), v.maxLength(8000)))
	}),
	async (data): Promise<GroupFormResult> => {
		const { db, env, group, membership, callerDid } = await context(data.groupDid);
		if (!can(membership.permissions, 'MANAGE_GROUP')) {
			return { ok: false, error: 'Not allowed: MANAGE_GROUP required' };
		}
		try {
			await updateGroup(db, group.id, {
				name: data.name,
				description: data.description || null,
				visibility: data.visibility,
				requireApproval: data.requireApproval
			});
		} catch (e) {
			return formError(e);
		}

		// THEN the records, which are the source of truth for the fields above.
		// The cache is written first only because the schema is what adjudicates
		// the forbidden private/open-join pair (migrations/0003) — writing a
		// record for a configuration the database would refuse would leave the
		// space describing a group that cannot exist. (Spec: FR-004, FR-016a.)
		try {
			// The row we just updated, without re-reading it: the profile must
			// describe the group as it now IS, and `joinPolicy` is derived from
			// these two columns (FR-004b).
			const fresh = {
				...group,
				name: data.name,
				description: data.description || null,
				visibility: data.visibility,
				require_approval: data.requireApproval ? 1 : 0
			};
			const reader = await groupSpaceReader(env, db, group);
			const about = reader ? await readGroupAbout(reader, group) : { profile: null, rules: [] };
			const writer = await groupWriter(env, db, fresh);
			await writeGroupProfile({
				db,
				env,
				group: fresh,
				callerDid,
				writer,
				profile: {
					name: data.name,
					description: data.description || null,
					// Not on the settings form, so it is carried rather than cleared.
					locationName: group.location_name,
					// Preserved, so editing a group does not restamp its creation date.
					createdAt: about.profile?.createdAt ?? undefined
				}
			});
			await setGroupRules({
				db,
				env,
				group: fresh,
				callerDid,
				writer,
				desired: splitRuleLines(data.rules),
				existing: about.rules
			});
			// AND THE NETWORK'S VIEW OF WHETHER THIS GROUP EXISTS. Visibility is
			// on this form, so this is the edit that can turn a discoverable
			// group into a hidden one: a group switched to private has its
			// declaration DELETED, not merely left unwritten, because the record
			// is the only thing an anonymous peer can see and a stale one keeps
			// announcing a group that asked not to be announced. Switching back
			// re-declares it, dated from the group's own creation date rather
			// than the moment of the flip — the declaration says when the group
			// came into existence, not when someone last toggled a checkbox, and
			// taking it from the profile costs no extra read. (Spec: FR-003.)
			await reconcileGroupDeclaration({
				db,
				env,
				group: fresh,
				callerDid,
				writer,
				createdAt: about.profile?.createdAt ?? undefined
			});
		} catch (e) {
			return {
				ok: false,
				error: `Settings were saved, but this group's records were not updated: ${
					e instanceof Error ? e.message : String(e)
				}`
			};
		}
		return { ok: true };
	}
);

/** A roster act whose SECOND half failed after its first took effect.
 *
 *  Not a failed mutation, because part of it happened, so the caller is told
 *  what is out of step rather than being told to retry something that already
 *  took effect. Which half runs second depends on the direction of the change
 *  (`server/roster.ts`): a grant moves the row and then writes the record
 *  (`RosterRecordError`), a revocation deletes the record and then the row
 *  (`RosterRowError`). Every other failure — an owner who cannot be demoted, a
 *  private group with no self-service join, a DID that is not on the roster, or
 *  a revocation's record write that changed nothing — is a plain one.
 *
 *  Returns the FAILURE member rather than `GroupFormResult`, so it composes in
 *  a handler whose success carries a payload. */
function rosterFailure(e: unknown): GroupFormFailure {
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

/** Self-service leave, and withdrawal of a pending request — the same button,
 *  because from the applicant's side they are the same intent. The owner can do
 *  neither: the roster pre-check refuses before any write, and that refusal
 *  surfaces as a GroupRuleError rather than a 500. */
export const leaveGroupForm = form(
	v.object({ groupDid: didField }),
	async (data): Promise<GroupFormResult<{ outcome: 'withdrawn' | 'left' }>> => {
		const ctx = await context(data.groupDid);
		try {
			// A pending applicant was never on the roster, so there is no record to
			// revoke — withdrawing touches `join_requests` and nothing else.
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
			return { ok: false, error: 'Not allowed: ADMIT_MEMBERS required' };
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
			return { ok: false, error: 'Not allowed: ADMIT_MEMBERS required' };
		}
		try {
			// No record either way: a rejected request never granted anything, so
			// there is nothing published to withdraw.
			await decideJoinRequest(db, group.id, data.requestId, callerDid, 'rejected');
			return { ok: true };
		} catch (e) {
			return formError(e);
		}
	}
);

/** Direct add, for an admin putting a known DID straight on the roster without
 *  a request. Same gate as approval: a reviewer who may admit may admit. */
export const addMemberForm = form(
	v.object({ groupDid: didField, did: didField, role: v.optional(assignableRoleField) }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await context(data.groupDid);
		if (!can(ctx.membership.permissions, 'ADMIT_MEMBERS')) {
			return { ok: false, error: 'Not allowed: ADMIT_MEMBERS required' };
		}
		try {
			await admitMember(ctx, data.did, data.role ?? 'member');
			return { ok: true };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);

export const removeMemberForm = form(
	v.object({ groupDid: didField, did: didField }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await context(data.groupDid);
		if (!can(ctx.membership.permissions, 'EJECT_MEMBERS')) {
			return { ok: false, error: 'Not allowed: EJECT_MEMBERS required' };
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
			return { ok: false, error: 'Not allowed: ASSIGN_ROLES required' };
		}
		try {
			await promoteMember(ctx, data.did, data.role);
			return { ok: true };
		} catch (e) {
			return rosterFailure(e);
		}
	}
);

/** `<input type="datetime-local">` sends `YYYY-MM-DDTHH:mm` with no zone, and
 *  `new Date()` would then read it in the SERVER's zone — a Worker's, i.e. UTC
 *  in production and whatever the laptop is in dev. The group event form labels
 *  its time fields UTC; this is where that promise is kept. A value that DOES
 *  carry a zone (or Z) is left alone. v1 has no per-group timezone picker. */
function zonelessAsUtc(value: string): Date {
	return new Date(/([zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`);
}

/** Create or edit a group event. The record is authored by the GROUP DID; the
 *  signed-in admin is only the authoriser. An `rkey` in the payload means edit,
 *  which needs MANAGE_EVENTS — that is how a non-owner admin edits an event
 *  they did not create. */
export const saveGroupEventForm = form(
	v.object({
		groupDid: didField,
		rkey: v.optional(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/))),
		name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
		description: v.optional(v.pipe(v.string(), v.maxLength(10000))),
		startsAt: v.pipe(v.string(), v.minLength(1)),
		endsAt: v.optional(v.string()),
		locationName: v.optional(v.pipe(v.string(), v.maxLength(300))),
		locationCountry: v.optional(countryField),
		createdAt: v.optional(v.string())
	}),
	async (data): Promise<GroupFormResult<{ uri: string; repo: string; rkey: string }>> => {
		const { db, env, group, callerDid } = await context(data.groupDid);
		const intent = data.rkey ? 'update' : 'create';

		const startsAt = zonelessAsUtc(data.startsAt);
		if (Number.isNaN(startsAt.getTime())) {
			return { ok: false, error: 'Start time is not a valid date' };
		}
		const endsAt = data.endsAt ? zonelessAsUtc(data.endsAt) : null;
		if (endsAt && Number.isNaN(endsAt.getTime())) {
			return { ok: false, error: 'End time is not a valid date' };
		}

		const record = groupEventRecord({
			name: data.name,
			description: data.description,
			startsAt: startsAt.toISOString(),
			endsAt: endsAt?.toISOString() ?? null,
			locationName: data.locationName,
			locationCountry: data.locationCountry,
			createdAt: data.createdAt
		});

		try {
			// The gate owns the permission decision; it re-resolves the caller's
			// membership itself rather than trusting a value passed in.
			const result = await writeGroupEvent({
				db,
				env,
				group,
				callerDid,
				intent,
				rkey: data.rkey,
				record
			});
			return { ok: true, uri: result.uri, repo: result.repo, rkey: result.rkey };
		} catch (e) {
			return formError(e);
		}
	}
);

export const deleteGroupEventForm = form(
	v.object({ groupDid: didField, rkey: v.pipe(v.string(), v.minLength(1), v.maxLength(512)) }),
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

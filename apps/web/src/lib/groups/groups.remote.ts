// Every group mutation, as SvelteKit remote `form` functions — the house style
// for writes in this app ($lib/atproto/server/repo.remote.ts,
// $lib/contrail/events.remote.ts). Reads stay in the routes' `+page.server.ts`
// loads.
//
// Shape of every handler: resolve the group by slug, resolve the CALLER's
// membership, ask `can()`, then act. `locals.did` is only ever the subject of
// that check — group events are authored by the group's own DID (see
// ./server/event-writer.ts).
import { error } from '@sveltejs/kit';
import { form, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { canSeeGroup } from './access';
import { ASSIGNABLE_ROLES, can } from './permissions';
import type { GroupFormFailure, GroupFormResult } from './form-result';
import { formError } from './form-error';
import { runCreateGroup } from './create-group';
import { GROUP_SLUG_PATTERN } from './slug';
import { GROUP_STATUSES, GROUP_VISIBILITIES, type CallerMembership, type GroupRow } from './types';
import {
	decideJoinRequest,
	getCallerMembership,
	getGroupBySlug,
	updateGroup,
	type JoinOutcome
} from './server/repo';
import { deleteGroupEvent, groupWriter, writeGroupEvent } from './server/event-writer';
import { splitRuleLines } from './about-record';
import { groupSpaceReader, readGroupAbout } from './server/about-read';
import { setGroupRules, writeGroupProfile } from './server/about-writer';
// Every roster act is a row move PLUS a record write, composed once in
// ./server/roster.ts so the app and the e2e harness drive the same sequence.
import {
	RosterRecordError,
	admitFromRequest,
	admitMember,
	ejectMember,
	joinGroup,
	leaveGroup,
	promoteMember,
	setMemberAccess
} from './server/roster';
import { groupEventRecord } from './event-record';

const slugField = v.pipe(v.string(), v.regex(GROUP_SLUG_PATTERN, 'Invalid group URL'));
const didField = v.pipe(v.string(), v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,300}$/, 'Invalid DID'));
const idField = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
/** An HTML checkbox sends `on` when ticked and nothing at all when not, so
 *  presence is the value. */
const checkboxField = v.pipe(
	v.optional(v.string()),
	v.transform((value) => value !== undefined && value !== '')
);
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
 *  permissions. Throws 404 for an unknown slug and 401 when not signed in.
 *
 *  AN INVISIBLE GROUP IS A MISSING GROUP, and it is `canSeeGroup` that decides
 *  — the same predicate the pages use (routes/(app)/groups/[slug]/**), so the
 *  rule has one definition and a form cannot disagree with the page it was
 *  posted from. Without this a remote `form()` was a private group's existence
 *  oracle: a remote function is an addressable POST bound to nothing but
 *  sign-in and the slug, so the page's own 404 never ran (om-5oxc8). The
 *  membership lookup has to come first, because whether the caller may see the
 *  group is a question about their roster row. */
async function context(slug: string): Promise<GroupRequestContext> {
	const { locals, platform } = getRequestEvent();
	if (!locals.did) error(401, 'Sign in to do that');
	const db = platform!.env.DB;
	const group = await getGroupBySlug(db, slug);
	if (!group) error(404, 'Group not found');
	const membership = await getCallerMembership(db, group.id, locals.did);
	if (!canSeeGroup(group, membership)) error(404, 'Group not found');
	return { db, env: platform!.env, group, membership, callerDid: locals.did };
}

export const createGroupForm = form(
	v.object({
		name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
		slug: slugField,
		description: v.optional(v.pipe(v.string(), v.maxLength(4000))),
		visibility: v.picklist(GROUP_VISIBILITIES),
		status: v.picklist(GROUP_STATUSES),
		requireApproval: checkboxField,
		// No `spaceUri` field: the group's two spaces are CREATED here now, not
		// bound to a string someone pasted in.
		locationName: v.optional(v.pipe(v.string(), v.maxLength(200))),
		locationAddress: v.optional(v.pipe(v.string(), v.maxLength(400))),
		locationTimezone: v.optional(v.pipe(v.string(), v.maxLength(80))),
		/** No column behind this one: the rule RECORDS are the only copy. */
		rules: v.optional(v.pipe(v.string(), v.maxLength(8000)))
	}),
	async (data): Promise<GroupFormResult<{ groupSlug: string; recoveryKey: string }>> => {
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
		slug: slugField,
		name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
		description: v.optional(v.pipe(v.string(), v.maxLength(4000))),
		visibility: v.picklist(GROUP_VISIBILITIES),
		status: v.picklist(GROUP_STATUSES),
		requireApproval: checkboxField,
		rules: v.optional(v.pipe(v.string(), v.maxLength(8000)))
	}),
	async (data): Promise<GroupFormResult> => {
		const { db, env, group, membership, callerDid } = await context(data.slug);
		if (!can(membership.permissions, 'MANAGE_GROUP')) {
			return { ok: false, error: 'Not allowed: MANAGE_GROUP required' };
		}
		try {
			await updateGroup(db, group.id, {
				name: data.name,
				description: data.description || null,
				status: data.status,
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
		} catch (e) {
			return {
				ok: false,
				error: `Settings were saved, but ${group.slug}'s records were not updated: ${
					e instanceof Error ? e.message : String(e)
				}`
			};
		}
		return { ok: true };
	}
);

/** A roster act whose ROW moved and whose RECORD did not.
 *
 *  Not a failed mutation, because the mutation happened: the roster the app
 *  renders falls back to the rows (`server/members-read.ts`), so the caller is
 *  told what is out of step rather than being told to retry something that
 *  already took effect. Every other failure — an owner who cannot be demoted, a
 *  private group with no self-service join, a DID that is not on the roster —
 *  comes from the SCHEMA, which is why the two are one `catch` with two
 *  reports: the D1 half always runs first (`server/roster.ts`).
 *
 *  Returns the FAILURE member rather than `GroupFormResult`, so it composes in
 *  a handler whose success carries a payload. */
function rosterFailure(slug: string, e: unknown): GroupFormFailure {
	if (e instanceof RosterRecordError) {
		return {
			ok: false,
			error: `The roster was updated, but ${slug}'s membership record for ${e.subject} was not: ${e.message}`
		};
	}
	return formError(e);
}

export const joinGroupForm = form(
	v.object({
		slug: slugField,
		message: v.optional(v.pipe(v.string(), v.maxLength(1000)))
	}),
	async (data): Promise<GroupFormResult<{ outcome: JoinOutcome }>> => {
		const ctx = await context(data.slug);
		try {
			return { ok: true, outcome: await joinGroup(ctx, data.message || null) };
		} catch (e) {
			return rosterFailure(ctx.group.slug, e);
		}
	}
);

/** Self-service leave, and withdrawal of a pending request — the same button,
 *  because from the applicant's side they are the same intent. The owner can do
 *  neither: `memberships_owner_undeletable` refuses, and that refusal surfaces
 *  as a GroupRuleError rather than a 500. */
export const leaveGroupForm = form(
	v.object({ slug: slugField }),
	async (data): Promise<GroupFormResult<{ outcome: 'withdrawn' | 'left' }>> => {
		const ctx = await context(data.slug);
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
			return rosterFailure(ctx.group.slug, e);
		}
	}
);

export const approveJoinRequestForm = form(
	v.object({
		slug: slugField,
		requestId: idField,
		role: v.optional(assignableRoleField)
	}),
	async (data): Promise<GroupFormResult> => {
		const ctx = await context(data.slug);
		if (!can(ctx.membership.permissions, 'ADMIT_MEMBERS')) {
			return { ok: false, error: 'Not allowed: ADMIT_MEMBERS required' };
		}
		try {
			await admitFromRequest(ctx, data.requestId, data.role ?? 'member');
			return { ok: true };
		} catch (e) {
			return rosterFailure(ctx.group.slug, e);
		}
	}
);

export const rejectJoinRequestForm = form(
	v.object({ slug: slugField, requestId: idField }),
	async (data): Promise<GroupFormResult> => {
		const { db, group, membership, callerDid } = await context(data.slug);
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
	v.object({ slug: slugField, did: didField, role: v.optional(assignableRoleField) }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await context(data.slug);
		if (!can(ctx.membership.permissions, 'ADMIT_MEMBERS')) {
			return { ok: false, error: 'Not allowed: ADMIT_MEMBERS required' };
		}
		try {
			await admitMember(ctx, data.did, data.role ?? 'member');
			return { ok: true };
		} catch (e) {
			return rosterFailure(ctx.group.slug, e);
		}
	}
);

export const removeMemberForm = form(
	v.object({ slug: slugField, did: didField }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await context(data.slug);
		if (!can(ctx.membership.permissions, 'EJECT_MEMBERS')) {
			return { ok: false, error: 'Not allowed: EJECT_MEMBERS required' };
		}
		try {
			await ejectMember(ctx, data.did);
			return { ok: true };
		} catch (e) {
			return rosterFailure(ctx.group.slug, e);
		}
	}
);

export const changeMemberRoleForm = form(
	v.object({ slug: slugField, did: didField, role: assignableRoleField }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await context(data.slug);
		if (!can(ctx.membership.permissions, 'ASSIGN_ROLES')) {
			return { ok: false, error: 'Not allowed: ASSIGN_ROLES required' };
		}
		try {
			await promoteMember(ctx, data.did, data.role);
			return { ok: true };
		} catch (e) {
			return rosterFailure(ctx.group.slug, e);
		}
	}
);

export const setMemberStatusForm = form(
	v.object({ slug: slugField, did: didField, status: v.picklist(['active', 'suspended']) }),
	async (data): Promise<GroupFormResult> => {
		const ctx = await context(data.slug);
		// Suspension is a partial removal, so it is the eject grant rather than a
		// third name: a greeter who may admit must not be able to lock a member out.
		if (!can(ctx.membership.permissions, 'EJECT_MEMBERS')) {
			return { ok: false, error: 'Not allowed: EJECT_MEMBERS required' };
		}
		try {
			await setMemberAccess(ctx, data.did, data.status);
			return { ok: true };
		} catch (e) {
			return rosterFailure(ctx.group.slug, e);
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
		slug: slugField,
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
		const { db, env, group, callerDid } = await context(data.slug);
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
	v.object({ slug: slugField, rkey: v.pipe(v.string(), v.minLength(1), v.maxLength(512)) }),
	async (data): Promise<GroupFormResult<{ uri: string }>> => {
		const { db, env, group, callerDid } = await context(data.slug);
		try {
			const result = await deleteGroupEvent({ db, env, group, callerDid, rkey: data.rkey });
			return { ok: true, uri: result.uri };
		} catch (e) {
			return formError(e);
		}
	}
);

// Every group mutation, as SvelteKit remote `form` functions — the house style
// for writes in this app ($lib/atproto/server/repo.remote.ts,
// $lib/contrail/events.remote.ts). Reads stay in the routes' `+page.server.ts`
// loads.
//
// Shape of every handler: resolve the group by slug, resolve the CALLER's
// membership, ask `can()`, then act. `locals.did` is only ever the subject of
// that check — group events are authored by the group's own DID (see
// ./server/event-writer.ts).
import { error, redirect } from '@sveltejs/kit';
import { form, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { ASSIGNABLE_ROLES, can } from './permissions';
import type { GroupFormFailure, GroupFormResult } from './form-result';
import { GROUP_SLUG_PATTERN } from './slug';
import { GROUP_STATUSES, GROUP_VISIBILITIES } from './types';
import { AUTO_MINT_GROUP_DID, custodialDids } from './server/credentials';
import {
	GroupRuleError,
	addMember,
	approveJoinRequest,
	changeMemberRole,
	createGroup,
	decideJoinRequest,
	getCallerMembership,
	getGroupBySlug,
	removeMember,
	requestJoin,
	setMemberStatus,
	updateGroup,
	type JoinOutcome
} from './server/repo';
import {
	GroupCredentialError,
	GroupPermissionError,
	GroupRecordError,
	deleteGroupEvent,
	writeGroupEvent
} from './server/event-writer';
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

/** The three things every handler needs, plus the caller's resolved
 *  permissions. Throws 404 for an unknown slug and 401 when not signed in. */
async function context(slug: string) {
	const { locals, platform } = getRequestEvent();
	if (!locals.did) error(401, 'Sign in to do that');
	const db = platform!.env.DB;
	const group = await getGroupBySlug(db, slug);
	if (!group) error(404, 'Group not found');
	const membership = await getCallerMembership(db, group.id, locals.did);
	return { db, env: platform!.env, group, membership, callerDid: locals.did };
}

/** Turns the domain errors into the shape a form renders. Permission and
 *  credential failures are deliberately distinguished: one is the user's
 *  business, the other is the operator's. */
function formError(e: unknown): GroupFormFailure {
	if (e instanceof GroupPermissionError) {
		return { ok: false, error: `Not allowed: ${e.permission} required` };
	}
	if (e instanceof GroupCredentialError) {
		return {
			ok: false,
			error:
				'This group has no signing credential configured on this deployment, so it cannot publish events.'
		};
	}
	if (e instanceof GroupRecordError) return { ok: false, error: e.message };
	if (e instanceof GroupRuleError) return { ok: false, error: e.message };
	throw e;
}

export const createGroupForm = form(
	v.object({
		name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
		slug: slugField,
		groupDid: didField,
		description: v.optional(v.pipe(v.string(), v.maxLength(4000))),
		visibility: v.picklist(GROUP_VISIBILITIES),
		status: v.picklist(GROUP_STATUSES),
		requireApproval: checkboxField,
		spaceUri: v.optional(v.pipe(v.string(), v.maxLength(512))),
		locationName: v.optional(v.pipe(v.string(), v.maxLength(200))),
		locationAddress: v.optional(v.pipe(v.string(), v.maxLength(400))),
		locationTimezone: v.optional(v.pipe(v.string(), v.maxLength(80)))
	}),
	async (data): Promise<GroupFormResult> => {
		const { locals, platform } = getRequestEvent();
		if (!locals.did) error(401, 'Sign in to create a group');
		const env = platform!.env;

		// Creation BINDS an existing custodial DID; it never mints one. A DID the
		// app holds no credential for would produce a group that can never publish,
		// so it is refused here rather than discovered at the first event write.
		// AUTO_MINT_GROUP_DID is the seam where minting will plug in; it is off.
		const known = custodialDids(env);
		if (!known.includes(data.groupDid)) {
			if (AUTO_MINT_GROUP_DID) {
				// Unreachable while the flag is false. Left as the single place the
				// minting path attaches, with no stub behind it: a placeholder DID
				// would create groups whose records can never be written.
				error(501, 'Automatic group DID minting is not implemented');
			}
			return {
				ok: false,
				error:
					known.length === 0
						? 'No custodial group DIDs are configured on this deployment (set GROUP_CREDENTIALS).'
						: `Unknown group DID. Configured: ${known.join(', ')}`
			};
		}

		let slug: string;
		try {
			const group = await createGroup(platform!.env.DB, {
				groupDid: data.groupDid,
				ownerDid: locals.did,
				name: data.name,
				slug: data.slug,
				description: data.description || null,
				status: data.status,
				visibility: data.visibility,
				requireApproval: data.requireApproval,
				spaceUri: data.spaceUri || null,
				locationName: data.locationName || null,
				locationAddress: data.locationAddress || null,
				locationTimezone: data.locationTimezone || null
			});
			slug = group.slug;
		} catch (e) {
			return formError(e);
		}
		redirect(303, `/groups/${slug}`);
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
		spaceUri: v.optional(v.pipe(v.string(), v.maxLength(512)))
	}),
	async (data): Promise<GroupFormResult> => {
		const { db, group, membership } = await context(data.slug);
		if (!can(membership.permissions, 'MANAGE_GROUP')) {
			return { ok: false, error: 'Not allowed: MANAGE_GROUP required' };
		}
		try {
			await updateGroup(db, group.id, {
				name: data.name,
				description: data.description || null,
				status: data.status,
				visibility: data.visibility,
				requireApproval: data.requireApproval,
				spaceUri: data.spaceUri || null
			});
		} catch (e) {
			return formError(e);
		}
		return { ok: true };
	}
);

export const joinGroupForm = form(
	v.object({
		slug: slugField,
		message: v.optional(v.pipe(v.string(), v.maxLength(1000)))
	}),
	async (data): Promise<GroupFormResult<{ outcome: JoinOutcome }>> => {
		const { db, group, callerDid } = await context(data.slug);
		try {
			const outcome = await requestJoin(db, group, callerDid, data.message || null);
			return { ok: true, outcome };
		} catch (e) {
			return formError(e);
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
		const { db, group, membership, callerDid } = await context(data.slug);
		try {
			if (membership.pendingRequestId) {
				await decideJoinRequest(db, group.id, membership.pendingRequestId, callerDid, 'withdrawn');
				return { ok: true, outcome: 'withdrawn' };
			}
			await removeMember(db, group.id, callerDid);
			return { ok: true, outcome: 'left' };
		} catch (e) {
			return formError(e);
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
		const { db, group, membership, callerDid } = await context(data.slug);
		if (!can(membership.permissions, 'MANAGE_MEMBERS')) {
			return { ok: false, error: 'Not allowed: MANAGE_MEMBERS required' };
		}
		try {
			await approveJoinRequest(db, group.id, data.requestId, callerDid, data.role ?? 'member');
			return { ok: true };
		} catch (e) {
			return formError(e);
		}
	}
);

export const rejectJoinRequestForm = form(
	v.object({ slug: slugField, requestId: idField }),
	async (data): Promise<GroupFormResult> => {
		const { db, group, membership, callerDid } = await context(data.slug);
		if (!can(membership.permissions, 'MANAGE_MEMBERS')) {
			return { ok: false, error: 'Not allowed: MANAGE_MEMBERS required' };
		}
		try {
			await decideJoinRequest(db, group.id, data.requestId, callerDid, 'rejected');
			return { ok: true };
		} catch (e) {
			return formError(e);
		}
	}
);

/** Direct add, for an admin putting a known DID straight on the roster without
 *  a request. Same gate as approval. */
export const addMemberForm = form(
	v.object({ slug: slugField, did: didField, role: v.optional(assignableRoleField) }),
	async (data): Promise<GroupFormResult> => {
		const { db, group, membership } = await context(data.slug);
		if (!can(membership.permissions, 'MANAGE_MEMBERS')) {
			return { ok: false, error: 'Not allowed: MANAGE_MEMBERS required' };
		}
		try {
			await addMember(db, group.id, data.did, data.role ?? 'member');
			return { ok: true };
		} catch (e) {
			return formError(e);
		}
	}
);

export const removeMemberForm = form(
	v.object({ slug: slugField, did: didField }),
	async (data): Promise<GroupFormResult> => {
		const { db, group, membership } = await context(data.slug);
		if (!can(membership.permissions, 'MANAGE_MEMBERS')) {
			return { ok: false, error: 'Not allowed: MANAGE_MEMBERS required' };
		}
		try {
			await removeMember(db, group.id, data.did);
			return { ok: true };
		} catch (e) {
			return formError(e);
		}
	}
);

export const changeMemberRoleForm = form(
	v.object({ slug: slugField, did: didField, role: assignableRoleField }),
	async (data): Promise<GroupFormResult> => {
		const { db, group, membership } = await context(data.slug);
		if (!can(membership.permissions, 'MANAGE_MEMBERS')) {
			return { ok: false, error: 'Not allowed: MANAGE_MEMBERS required' };
		}
		try {
			await changeMemberRole(db, group.id, data.did, data.role);
			return { ok: true };
		} catch (e) {
			return formError(e);
		}
	}
);

export const setMemberStatusForm = form(
	v.object({ slug: slugField, did: didField, status: v.picklist(['active', 'suspended']) }),
	async (data): Promise<GroupFormResult> => {
		const { db, group, membership } = await context(data.slug);
		if (!can(membership.permissions, 'MANAGE_MEMBERS')) {
			return { ok: false, error: 'Not allowed: MANAGE_MEMBERS required' };
		}
		try {
			await setMemberStatus(db, group.id, data.did, data.status);
			return { ok: true };
		} catch (e) {
			return formError(e);
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

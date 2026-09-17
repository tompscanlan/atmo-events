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
import { ASSIGNABLE_ROLES, can } from './permissions';
import type { GroupFormFailure, GroupFormResult } from './form-result';
import { GROUP_SLUG_PATTERN, slugMintRefusal, slugMintRefusalMessage } from './slug';
import { GROUP_STATUSES, GROUP_VISIBILITIES } from './types';
import {
	GroupCredentialKeyError,
	canStoreMintedCredentials,
	storeGroupCredential
} from './server/credentials';
import { GroupMintError, mintGroupAccount, type MintConfig, type MintFailure } from './server/mint';
import {
	GroupRuleError,
	addMember,
	approveJoinRequest,
	changeMemberRole,
	createGroup,
	decideJoinRequest,
	getCallerMembership,
	getGroupBySlug,
	recordGroupSpaces,
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
import { GroupSpaceError, pdsProvisioner, provisionGroupSpaces } from './server/spaces';
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

/** The mint target, or null when this deployment is not configured to mint. All
 *  four values are required: a partial configuration is an operator error, and
 *  finding out mid-flight would mean discovering it after a did:plc exists. */
function mintConfig(env: {
	GROUP_PDS_SERVICE?: string;
	GROUP_HANDLE_DOMAIN?: string;
	GROUP_PDS_INVITE_CODE?: string;
	GROUP_ACCOUNT_EMAIL?: string;
}): MintConfig | null {
	const service = env.GROUP_PDS_SERVICE?.trim();
	const handleDomain = env.GROUP_HANDLE_DOMAIN?.trim();
	const inviteCode = env.GROUP_PDS_INVITE_CODE?.trim();
	const accountEmail = env.GROUP_ACCOUNT_EMAIL?.trim();
	if (!service || !handleDomain || !inviteCode || !accountEmail) return null;
	return { service, handleDomain, inviteCode, accountEmail };
}

/** What a failed mint says to whoever is reading the form.
 *
 *  The user's cases name the field they can change. The operator's cases say
 *  "not you, and not your fault" WITHOUT guessing a cause: FR-001e forbids the
 *  create path from calling `com.atproto.admin.getInviteCodes`, so an unavailable
 *  code is genuinely ambiguous between exhausted and misconfigured, and claiming
 *  either would be a fabrication. `om-pl5pw` owns the detection. */
function mintErrorMessage(e: { failure: MintFailure; message: string }, slug: string): string {
	const operatorAlert = `Group creation is temporarily unavailable. This is a deployment problem, not something you did — please try again later or tell an administrator. (${e.failure})`;
	switch (e.failure) {
		case 'handle-taken':
			return `“${slug}” is already taken. Choose another URL name.`;
		case 'handle-invalid':
			return `The group PDS refused “${slug}” as an address. Choose another URL name.`;
		case 'rotation-key-unverified':
			// Deliberately not swallowed: the group would exist without the owner
			// holding rotationKeys[0], i.e. portable in name only (FR-001g).
			return `“${slug}” was registered, but we could not confirm that you hold its recovery key, so it has not been set up as your group. Tell an administrator before creating it again. (${e.message})`;
		case 'invite-missing':
		case 'invite-unavailable':
		case 'email-rejected':
		case 'pds-unreachable':
			return operatorAlert;
	}
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
		locationTimezone: v.optional(v.pipe(v.string(), v.maxLength(80)))
	}),
	async (data): Promise<GroupFormResult<{ groupSlug: string; recoveryKey: string }>> => {
		const { locals, platform } = getRequestEvent();
		if (!locals.did) error(401, 'Sign in to create a group');
		const env = platform!.env;

		// REFUSE BEFORE MINTING, in two ways, because a did:plc cannot be recalled.
		//
		// 1. The label must be one the PDS will accept as a handle. Our slug rules
		//    are wider than its handle rules (3-18, no dot, not reserved), and the
		//    handle registration IS the name reservation (FR-001a), so a label we
		//    could not mint must fail on the field the user can edit.
		const refusal = slugMintRefusal(data.slug);
		if (refusal) return { ok: false, error: slugMintRefusalMessage(refusal, data.slug) };

		// 2. The deployment must be able to KEEP what the mint hands back once.
		//    Checking after the mint would strand an account whose only credential
		//    has already been shown and discarded.
		const mint = mintConfig(env);
		if (!mint) {
			return {
				ok: false,
				error:
					'Group creation is unavailable on this deployment: the group PDS is not configured. An administrator needs to set GROUP_PDS_SERVICE, GROUP_HANDLE_DOMAIN, GROUP_PDS_INVITE_CODE and GROUP_ACCOUNT_EMAIL.'
			};
		}
		if (!(await canStoreMintedCredentials(env))) {
			return {
				ok: false,
				error:
					'Group creation is unavailable on this deployment: there is nowhere to keep the new group’s credential. An administrator needs to set GROUP_CREDENTIAL_KEY.'
			};
		}

		let minted;
		try {
			minted = await mintGroupAccount(mint, data.slug);
		} catch (e) {
			if (e instanceof GroupMintError) return { ok: false, error: mintErrorMessage(e, data.slug) };
			throw e;
		}

		// The app password was shown exactly once, so it is stored BEFORE the group
		// row: a failure here leaves an orphan did:plc, and a failure after it would
		// leave one we can never write as again.
		try {
			await storeGroupCredential(env, env.DB, minted.did, minted.credential);
		} catch (e) {
			if (e instanceof GroupCredentialKeyError) {
				return {
					ok: false,
					error: `${minted.handle} was registered, but its credential could not be stored (${e.message}), so the group was not created. An administrator must fix GROUP_CREDENTIAL_KEY.`
				};
			}
			throw e;
		}

		let group;
		try {
			group = await createGroup(env.DB, {
				groupDid: minted.did,
				ownerDid: locals.did,
				name: data.name,
				// From the MINTED handle's leaf, never from the submitted field — the
				// PDS is what adjudicated the name, so its answer is the slug.
				slug: minted.handle.split('.')[0],
				description: data.description || null,
				status: data.status,
				visibility: data.visibility,
				requireApproval: data.requireApproval,
				locationName: data.locationName || null,
				locationAddress: data.locationAddress || null,
				locationTimezone: data.locationTimezone || null
			});
		} catch (e) {
			return formError(e);
		}

		// Provisioning is not ordered by the slug: the space key is `self`, so both
		// URIs are a function of the group DID alone.
		try {
			const uris = await provisionGroupSpaces(pdsProvisioner(minted.credential, minted.did));
			await recordGroupSpaces(env.DB, group.id, uris);
		} catch (e) {
			// The group EXISTS at this point, so saying "creation failed" would be a
			// lie. Name what is missing instead: `provisionGroupSpaces` is idempotent
			// (SpaceAlreadyExists resolves to the deterministic URI).
			const detail = e instanceof GroupSpaceError ? e.message : String(e);
			return {
				ok: false,
				error: `${group.slug} was created, but its spaces were not provisioned: ${detail}`
			};
		}

		// NO REDIRECT. The owner's rotation key is shown exactly once and is the
		// only thing that lets them move this group off our PDS (FR-001g); a 303
		// here would destroy it. The page renders it, then links onward.
		return { ok: true, groupSlug: group.slug, recoveryKey: minted.ownerRotationSecret };
	}
);

export const updateGroupForm = form(
	v.object({
		slug: slugField,
		name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
		description: v.optional(v.pipe(v.string(), v.maxLength(4000))),
		visibility: v.picklist(GROUP_VISIBILITIES),
		status: v.picklist(GROUP_STATUSES),
		requireApproval: checkboxField
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
				requireApproval: data.requireApproval
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

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
import type { JoinOutcome } from './server/repo';
import { groupActorToDid, groupRouteContext } from './server/route-context';
import {
	GROUP_EVENT_IMAGE_MAX_BYTES,
	checkEventSpace,
	deleteGroupEvent,
	uploadGroupEventImage,
	writeGroupEvent,
	type GroupBlobRef
} from './server/event-writer';
import { describeRepair, repairGroup } from './server/repair';
// ./server/roster.ts is shared with the e2e harness, so both run the same sequence.
import {
	admitFromRequest,
	admitMember,
	ejectMember,
	joinGroup,
	leaveGroup,
	rejectJoinRequest,
	promoteMember,
	RosterStepError,
	withdrawJoinRequest
} from './server/roster';
import { GroupSpaceError } from './server/spaces';
import { groupSpaceReader } from './server/about-read';
import { reauthorizeForGroup } from './server/member-grants';
import { memberSession, type MemberSession } from './server/acceptance';
// ./server/member-rsvp.ts is shared with the e2e harness, as ./server/roster.ts is.
import {
	deleteMembersOnlyRsvp,
	putMembersOnlyRsvp,
	type MembersOnlyRsvpCancel,
	type MembersOnlyRsvpPut
} from './server/member-rsvp';
import { createOAuthClient, servesClientMetadata } from '$lib/atproto/server/oauth';
import { scopes } from '$lib/atproto/settings';
import type { Did } from '@atcute/lexicons';
import { RSVP_STATUSES } from './ids';

import { errorText } from './server/errors';
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
		rules: v.optional(v.pipe(v.string(), v.maxLength(8000))),
		/** The group account's login. Length and shape are checked by
		 *  `runCreateGroup`, so its refusal reads as a sentence. */
		email: v.pipe(v.string(), v.trim(), v.maxLength(254)),
		/** Underscored so SvelteKit never echoes it back with a failed form. */
		_password: v.pipe(v.string(), v.maxLength(256))
	}),
	async ({ _password: password, ...data }): Promise<CreateGroupOutcome> => {
		const { locals, platform } = getRequestEvent();
		if (!locals.did) error(401, 'Sign in to create a group');
		// No redirect: the result carries the owner's rotation key, which is shown
		// once and stored nowhere, so a 303 would lose it.
		return runCreateGroup(platform!.env, locals.did, { ...data, password });
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
					error: `The repair stopped partway: ${errorText(
						e
					)}. Anything it wrote is kept, and running it again continues from there.`
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
	if (e instanceof RosterStepError && e.step === 'list') {
		return {
			ok: false,
			error:
				e.change === 'grant'
					? `${e.subject} is on the roster, but was not added to the group's member lists at its PDS: ${e.message}. "Repair this group" in the group's settings adds them.`
					: e.change === 'request'
						? `Your request to join was sent, but the group's PDS did not record you as a requester: ${e.message}. An admin's "Repair this group", in the group's settings, records you.`
						: `${e.subject} can no longer read the group at its PDS, but their membership was not removed: ${e.message}. Removing them again finishes it.`
		};
	}
	if (e instanceof RosterStepError && e.step === 'record') {
		return {
			ok: false,
			error: `The roster was updated, but the membership record for ${e.subject} was not: ${e.message}`
		};
	}
	if (e instanceof RosterStepError) {
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

/** The caller's own session, for their acceptance (./server/acceptance.ts). Null
 *  when there is none to read, and then no acceptance is touched. */
async function callerMember(): Promise<MemberSession | null> {
	const { locals } = getRequestEvent();
	if (!locals.session) return null;
	try {
		return await memberSession(locals.session);
	} catch (e) {
		console.warn('[groups] no member session for the acceptance:', e);
		return null;
	}
}

/** Where to send a member who just joined or asked to join, so their session
 *  carries the group's acceptance grant before their next sign-in (spec FR-208:
 *  joining or requesting re-authorizes), or a member whose session lacks the
 *  grant when they RSVP to a members-only event. On a device the PDS remembers,
 *  nothing shows unless the request holds a grant not approved before. Otherwise
 *  the PDS asks for the password and consent again, listing every scope. Null
 *  when there is no client metadata to grow, or the PDS refused. */
async function reauthorizeUrl(ctx: GroupRequestContext): Promise<string | null> {
	if (!servesClientMetadata(ctx.env)) return null;
	const result = await reauthorizeForGroup(
		ctx.db,
		ctx.callerDid,
		ctx.group.group_did,
		Date.now(),
		(grants) =>
			createOAuthClient(ctx.env, grants).authorize({
				target: { type: 'account', identifier: ctx.callerDid as Did },
				scope: [...scopes, ...grants].join(' ')
			})
	);
	return result?.url.toString() ?? null;
}

export const joinGroupForm = form(
	v.object({
		groupDid: didField,
		message: v.optional(v.pipe(v.string(), v.maxLength(1000)))
	}),
	async (data): Promise<GroupFormResult<{ outcome: JoinOutcome; reauthorize: string | null }>> => {
		const ctx = await context(data.groupDid);
		let outcome: JoinOutcome;
		try {
			outcome = await joinGroup({ ...ctx, member: await callerMember() }, data.message || null);
		} catch (e) {
			return rosterFailure(e);
		}
		const changed = outcome === 'joined' || outcome === 'pending';
		return { ok: true, outcome, reauthorize: changed ? await reauthorizeUrl(ctx) : null };
	}
);

/** Leave, or withdraw a pending request: one button, since for the applicant
 *  they are the same intent. The owner cannot leave (a GroupRuleError). */
export const leaveGroupForm = form(
	v.object({ groupDid: didField }),
	async (data): Promise<GroupFormResult<{ outcome: 'withdrawn' | 'left' }>> => {
		const ctx = { ...(await context(data.groupDid)), member: await callerMember() };
		try {
			// A pending applicant has no record: their write-only entry comes off
			// the members space's list, and the request closes.
			if (ctx.membership.pendingRequestId) {
				await withdrawJoinRequest(ctx, ctx.membership.pendingRequestId);
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
		const ctx = await context(data.groupDid);
		if (!can(ctx.membership.permissions, 'ADMIT_MEMBERS')) {
			return notAllowed(ctx.membership, 'ADMIT_MEMBERS');
		}
		try {
			// A rejected request never granted anything, so there is no record,
			// only the requester's write-only entry and the request itself.
			await rejectJoinRequest(ctx, data.requestId);
			return { ok: true };
		} catch (e) {
			return rosterFailure(e);
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
//
// Both take the event's placement as `space`: the group's calendar space for a
// members-only event, null for a public one. It is nullable and never optional,
// so a page that forgets it is refused rather than written in public, and it is
// checked against the group's own calendar space before the caller's standing is
// read, so a space the page should never name costs the host nothing.
// (Spec: FR-116.)

/** Create or edit a group event, authored by the group DID. */
export const putGroupEvent = command(
	v.object({
		groupDid: didField,
		rkey: rkeyField,
		intent: eventIntentField,
		space: v.nullable(v.string()),
		record: v.record(v.string(), v.unknown())
	}),
	async (data): Promise<GroupFormResult<{ uri: string }>> => {
		let space: string | null;
		try {
			space = checkEventSpace(data.groupDid, data.space);
		} catch (e) {
			return formError(e);
		}
		const { db, env, group, callerDid } = await context(data.groupDid);
		try {
			const result = await writeGroupEvent({
				db,
				env,
				group,
				callerDid,
				intent: data.intent,
				rkey: data.rkey,
				space,
				record: data.record
			});
			return { ok: true, uri: result.uri };
		} catch (e) {
			return formError(e);
		}
	}
);

export const removeGroupEvent = command(
	v.object({ groupDid: didField, rkey: rkeyField, space: v.nullable(v.string()) }),
	async (data): Promise<GroupFormResult<{ uri: string }>> => {
		let space: string | null;
		try {
			space = checkEventSpace(data.groupDid, data.space);
		} catch (e) {
			return formError(e);
		}
		const { db, env, group, callerDid } = await context(data.groupDid);
		try {
			const result = await deleteGroupEvent({ db, env, group, callerDid, rkey: data.rkey, space });
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

// A member's RSVP to a members-only event, and its cancel. The page names the
// event, the answer and the version of the event it showed, and nothing else:
// the space, the collection, the key and the subject are the server's to choose
// (./server/member-rsvp.ts), so no input here takes any of them, and the cid is
// only compared. Each resolves the group and the caller's standing as every
// handler does, and the roster gate comes first in the module. A session that
// lacks the grant gets the re-authorize URL back, which the page follows, with
// a marker the page carries back as `asked`. (Spec: FR-113, FR-114, FR-120.)
const rsvpStatusField = v.picklist(RSVP_STATUSES);
/** Shape only: the module reads a marker it did not make as none. */
const askedField = v.nullable(v.pipe(v.string(), v.maxLength(2100)));

/** A stamp of the caller's session: when its token expires, in milliseconds,
 *  read without a refresh, or 0 when there is no session or it can't be read.
 *  A new sign-in issues a new token, which is how an asked marker tells a
 *  member back from consent from one who never left. */
async function sessionStamp(): Promise<number> {
	const { locals } = getRequestEvent();
	if (!locals.session) return 0;
	try {
		const { expiresAt } = await locals.session.getTokenInfo(false);
		return expiresAt?.getTime() ?? 0;
	} catch {
		return 0;
	}
}

/** What both commands hand the module about who is asking. */
async function rsvpCaller(groupDid: string, asked: string | null) {
	const ctx = await context(groupDid);
	return {
		ctx,
		target: {
			membership: ctx.membership,
			group: ctx.group,
			member: await callerMember(),
			callerDid: ctx.callerDid,
			stamp: await sessionStamp(),
			asked,
			reauthorize: () => reauthorizeUrl(ctx)
		}
	};
}

export const rsvpToMembersOnlyEvent = command(
	v.object({
		groupDid: didField,
		rkey: rkeyField,
		status: rsvpStatusField,
		cid: v.nullable(v.pipe(v.string(), v.maxLength(200))),
		asked: askedField
	}),
	async (data): Promise<MembersOnlyRsvpPut> => {
		const { ctx, target } = await rsvpCaller(data.groupDid, data.asked);
		return putMembersOnlyRsvp({
			...target,
			rkey: data.rkey,
			status: data.status,
			cid: data.cid,
			groupReader: () => groupSpaceReader(ctx.env, ctx.db, ctx.group)
		});
	}
);

export const cancelMembersOnlyRsvp = command(
	v.object({ groupDid: didField, rkey: rkeyField, asked: askedField }),
	async (data): Promise<MembersOnlyRsvpCancel> => {
		const { target } = await rsvpCaller(data.groupDid, data.asked);
		return deleteMembersOnlyRsvp({ ...target, rkey: data.rkey });
	}
);

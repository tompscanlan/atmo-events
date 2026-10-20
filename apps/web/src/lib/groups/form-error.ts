// Turns the domain errors into the shape a form renders. A plain module, so
// ./create-at-host.ts can share it: `*.remote.ts` may export only remote functions.
import type { GroupFormFailure } from './form-result';
import type { GroupPermission } from './permissions';
import type { CallerMembership } from './types';

import { GroupPermissionError, GroupRecordError } from './server/group-write';
import { GroupCredentialError } from './server/session';
import { GroupRuleError } from './server/db/rules';
import { RosterStepError } from './server/roster';
import { GroupSpaceError } from './server/spaces';
import { GroupNotAtHostError } from './server/host';
import { GroupHostError, HostSignInError } from './server/real-host';
const NOT_LINKED: GroupFormFailure = {
	ok: false,
	error:
		'This site cannot write as this group for you yet: link your access, from the group page. Nothing was changed.'
};

/** The session the stand-in host acts on is missing, which only the group's
 *  creator can fix. */
const HOST_NOT_LINKED: GroupFormFailure = {
	ok: false,
	error:
		'This site cannot write as this group yet: its creator has to link their access, from the group page. Nothing was changed.'
};

/** The form message for a domain error, or null for any other failure, which a
 *  caller words for what it had done so far. Permission and credential failures
 *  are kept apart: one is about the caller's roles, the other about the session
 *  the write would go out on. */
export function knownFormError(e: unknown): GroupFormFailure | null {
	if (e instanceof GroupPermissionError) {
		return { ok: false, error: `Not allowed: ${e.reason}` };
	}
	if (e instanceof GroupCredentialError) {
		return { ...(e.standInHost ? HOST_NOT_LINKED : NOT_LINKED) };
	}
	if (e instanceof GroupRecordError) return { ok: false, error: e.message };
	if (e instanceof GroupRuleError) return { ok: false, error: e.message };
	if (e instanceof HostSignInError) {
		return {
			ok: false,
			error:
				'Your sign-in does not let this site ask the group’s host for you. Sign in again, then try once more. Nothing was changed.'
		};
	}
	if (e instanceof GroupNotAtHostError) {
		return {
			ok: false,
			error:
				'This group is not at this site’s group host, so this site cannot change it. Nothing was changed.'
		};
	}
	if (e instanceof GroupHostError) {
		return {
			ok: false,
			error: `The group’s host refused this (${e.error ?? e.status}). Nothing was changed.`
		};
	}
	return null;
}

/** `knownFormError`, rethrowing anything else, because an unrecognized failure
 *  must not be flattened into a form message. */
export function formError(e: unknown): GroupFormFailure {
	const known = knownFormError(e);
	if (!known) throw e;
	return known;
}

/** The refusal for a caller who lacks `permission`. When the members space
 *  could not be read, or cannot be with the caller's sign-in, their permissions
 *  are unknown rather than missing, and "Not allowed" would send an owner
 *  looking for a role they already hold. */
export function notAllowed(
	membership: Pick<CallerMembership, 'unreadable' | 'noSpaceAccess' | 'signIn'>,
	permission: GroupPermission
): GroupFormFailure {
	if (membership.signIn) {
		return {
			ok: false,
			reason: 'sign-in-required',
			error:
				'Your current sign-in does not include this group. Nothing was changed. Reload this page to sign in again, then try once more.'
		};
	}
	if (membership.noSpaceAccess) {
		return {
			ok: false,
			reason: 'no-space-access',
			error:
				'Your permissions in this group could not be checked: your sign-in does not let this site read the group’s spaces. Nothing was changed; signing in again may fix it.'
		};
	}
	if (membership.unreadable) {
		return {
			ok: false,
			reason: 'members-unreadable',
			error: `Your permissions in this group could not be checked, because its members space did not answer (${membership.unreadable}). Nothing was changed; try again later.`
		};
	}
	return { ok: false, reason: 'permission-denied', error: `Not allowed: ${permission} required` };
}

/** Maps a roster failure to a form result. The three roster errors mean a
 *  later half of the act failed after an earlier half took effect
 *  (`server/roster.ts`), so the message says what is out of step. Returns the
 *  failure only, so it also fits a handler whose success carries a payload. */
export function rosterFailure(e: unknown): GroupFormFailure {
	if (e instanceof RosterStepError && e.step === 'list') {
		return {
			ok: false,
			error:
				e.change === 'grant'
					? `${e.subject} is on the roster, but was not added to the group's member lists at its PDS: ${e.message}. "Repair this group" in the group's settings adds them.`
					: e.change === 'assign'
						? `${e.subject}'s role was changed, but the group's member lists at its PDS were not updated to match: ${e.message}. "Repair this group" in the group's settings updates them.`
						: `${e.subject} no longer has access here, but the removal did not finish at the group's PDS: ${e.message}. Removing them again finishes it.`
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
	// A withdrawal's or a rejection's first write, the member-list removal, was refused.
	if (e instanceof GroupSpaceError) {
		return {
			ok: false,
			error: `The group's PDS did not accept the change, so nothing was changed: ${e.message}. Try again.`
		};
	}
	return formError(e);
}

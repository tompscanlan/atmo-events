// Turns the domain errors into the shape a form renders. A plain module, so
// ./create-group.ts can share it: `*.remote.ts` may export only remote functions.
import type { GroupFormFailure } from './form-result';
import type { GroupPermission } from './permissions';
import type { CallerMembership } from './types';

import { GroupPermissionError, GroupRecordError } from './server/group-write';
import { GroupCredentialError } from './server/session';
import { GroupRuleError } from './server/db/rules';
import { RosterStepError } from './server/roster';
import { GroupSpaceError } from './server/spaces';
const NOT_LINKED: GroupFormFailure = {
	ok: false,
	error:
		'This site cannot write as this group yet: its owner has to link the group’s account, from the group page. Nothing was changed.'
};

/** The form message for a domain error, or null for any other failure, which a
 *  caller words for what it had done so far. Permission and credential failures
 *  are kept apart: one is the caller's business, the other is the group
 *  owner's. */
export function knownFormError(e: unknown): GroupFormFailure | null {
	if (e instanceof GroupPermissionError) {
		return { ok: false, error: `Not allowed: ${e.permission} required` };
	}
	if (e instanceof GroupCredentialError) return { ...NOT_LINKED };
	if (e instanceof GroupRecordError) return { ok: false, error: e.message };
	if (e instanceof GroupRuleError) return { ok: false, error: e.message };
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
 *  could not be read, or cannot be because the group is not linked, their
 *  permissions are unknown rather than missing, and "Not allowed" would send an
 *  owner looking for a role they already hold. */
export function notAllowed(
	membership: Pick<CallerMembership, 'unreadable' | 'unlinked'>,
	permission: GroupPermission
): GroupFormFailure {
	// The same refusal the write gate gives an unlinked group, which these forms
	// would otherwise never reach.
	if (membership.unlinked) return { ...NOT_LINKED };
	if (membership.unreadable) {
		return {
			ok: false,
			error: `Your permissions in this group could not be checked, because its members space did not answer (${membership.unreadable}). Nothing was changed; try again later.`
		};
	}
	return { ok: false, error: `Not allowed: ${permission} required` };
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

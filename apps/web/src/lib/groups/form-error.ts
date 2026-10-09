// Turns the domain errors into the shape a form renders. A plain module, so
// ./create-group.ts can share it: `*.remote.ts` may export only remote functions.
import type { GroupFormFailure } from './form-result';
import type { GroupPermission } from './permissions';
import type { CallerMembership } from './types';

import { GroupPermissionError, GroupRecordError } from './server/group-write';
import { GroupCredentialError } from './server/session';
import { GroupRuleError } from './server/db/rules';
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

// Turns the domain errors into the shape a form renders. A plain module, so
// ./create-at-host.ts can share it: `*.remote.ts` may export only remote functions.
import type { GroupFormFailure } from './form-result';
import type { GroupPermission } from './permissions';
import type { CallerMembership } from './types';

import { GroupPermissionError, GroupRecordError } from './server/group-write';
import { GroupCredentialError } from './server/session';
import { GroupRuleError } from './server/db/rules';
import { GroupNotAtHostError } from './server/host';
import { GroupHostError, HostSignInError } from './server/real-host';

/** The caller holds no group session for the write to go out on, which only
 *  they can fix. */
const NOT_LINKED: GroupFormFailure = {
	ok: false,
	error:
		'This site cannot write as this group for you yet: link your access, from the group page. Nothing was changed.'
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
		return { ...NOT_LINKED };
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

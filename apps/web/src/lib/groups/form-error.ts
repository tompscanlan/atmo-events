// The domain errors as a form renders them; a plain module, so create-at-host.ts can share it.
import type { GroupFormFailure } from './form-result';
import type { GroupPermission } from './permissions';
import type { CallerMembership } from './types';

import { GroupPermissionError, GroupRecordError } from './server/group-write';
import { GroupCredentialError } from './server/session';
import { GroupRuleError } from './server/db/rules';
import { GroupHostError, GroupNotAtHostError, HostSignInError } from './server/host';

const NOT_LINKED: GroupFormFailure = {
	ok: false,
	error:
		'This site cannot write as this group for you yet: link your access, from the group page. Nothing was changed.'
};

/** Null for any other failure, which a caller words for what it had done so far. */
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

/** An unrecognized failure is rethrown, not flattened into a form message. */
export function formError(e: unknown): GroupFormFailure {
	const known = knownFormError(e);
	if (!known) throw e;
	return known;
}

/** When the members space could not be read, permissions are unknown, not missing. */
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

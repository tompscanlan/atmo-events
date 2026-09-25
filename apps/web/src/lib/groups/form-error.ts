// Turns the domain errors into the shape a form renders.
//
// Lives outside `groups.remote.ts` so the create flow (./create-group.ts) can
// share it: the Vite plugin rejects non-remote exports from `*.remote.ts`, so
// anything two handlers need has to sit in a plain module.
import type { GroupFormFailure } from './form-result';
import type { GroupPermission } from './permissions';
import type { CallerMembership } from './types';
import {
	GroupCredentialError,
	GroupPermissionError,
	GroupRecordError
} from './server/event-writer';
import { GroupRuleError } from './server/repo';

/** Permission and credential failures are kept apart: one is the user's
 *  business, the other is the operator's. Anything else is rethrown, because an
 *  unrecognized failure must not be flattened into a form message. */
export function formError(e: unknown): GroupFormFailure {
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

/** The refusal for a caller who lacks `permission`. When the members space
 *  could not be read, their permissions are unknown rather than missing, and
 *  "Not allowed" would send an owner looking for a role they already hold. */
export function notAllowed(
	membership: Pick<CallerMembership, 'unreadable'>,
	permission: GroupPermission
): GroupFormFailure {
	if (membership.unreadable) {
		return {
			ok: false,
			error: `Your permissions in this group could not be checked, because its members space did not answer (${membership.unreadable}). Nothing was changed; try again later.`
		};
	}
	return { ok: false, error: `Not allowed: ${permission} required` };
}

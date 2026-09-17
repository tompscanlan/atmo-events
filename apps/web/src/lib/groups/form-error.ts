// Turns the domain errors into the shape a form renders.
//
// Lives outside `groups.remote.ts` so the create flow (./create-group.ts) can
// share it: the Vite plugin rejects non-remote exports from `*.remote.ts`, so
// anything two handlers need has to sit in a plain module.
import type { GroupFormFailure } from './form-result';
import {
	GroupCredentialError,
	GroupPermissionError,
	GroupRecordError
} from './server/event-writer';
import { GroupRuleError } from './server/repo';

/** Permission and credential failures are deliberately distinguished: one is
 *  the user's business, the other is the operator's. Anything else rethrows —
 *  an unrecognised failure must not be flattened into a form message. */
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

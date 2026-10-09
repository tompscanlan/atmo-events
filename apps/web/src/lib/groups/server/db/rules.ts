// The schema's refusals, reported as `GroupRuleError`. migrations/0001_groups.sql
// enforces the invariants, so the D1 modules run their writes through `guard`
// instead of checking the rules again.
import { errorText } from '../errors';

/** Thrown for a rule the SQL refused. `reason` is a stable machine tag, so a
 *  route can map it to a status code without string matching. */
export class GroupRuleError extends Error {
	constructor(
		readonly reason: /** The group DID is already bound. This is the only uniqueness
			 *  failure a create can hit, since the handle reserves the name. */
			| 'did-taken'
			| 'owner-protected'
			| 'owner-role-reserved'
			| 'not-found'
			| 'already-pending'
			/** A stranger asked to join a group its host reads as private. */
			| 'invite-only'
			| 'constraint',
		message: string
	) {
		super(message);
		this.name = 'GroupRuleError';
	}
}

/** Maps a schema refusal onto the tags above, so the app never duplicates the
 *  schema's checks. SQLite names the columns of a violated unique index, not
 *  the index, and D1 wraps the same text, so matching is on column names and
 *  on the triggers' RAISE messages. */
export function constraintMessage(e: unknown): GroupRuleError | null {
	const text = errorText(e);
	// Triggers first: one statement can fire a trigger and trip a unique index.
	if (/owner role is reserved/.test(text)) {
		return new GroupRuleError('owner-role-reserved', 'The owner role is reserved for the owner');
	}
	if (/owner cannot be|owner role cannot be|owner must hold|are immutable/.test(text)) {
		return new GroupRuleError('owner-protected', 'The group owner cannot be changed');
	}
	if (/UNIQUE constraint failed/.test(text)) {
		if (/groups\.group_did/.test(text)) {
			return new GroupRuleError('did-taken', 'That DID is already bound to another group');
		}
		if (/join_requests\.(group_id|did)/.test(text)) {
			return new GroupRuleError('already-pending', 'A join request is already pending');
		}
		if (/memberships\.(group_id|did)/.test(text)) {
			return new GroupRuleError('constraint', 'That DID is already on the roster');
		}
	}
	if (/SQLITE_CONSTRAINT|constraint failed|FOREIGN KEY/i.test(text)) {
		return new GroupRuleError('constraint', 'That change is not allowed');
	}
	return null;
}

export async function guard<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (e) {
		const mapped = constraintMessage(e);
		if (mapped) throw mapped;
		throw e;
	}
}

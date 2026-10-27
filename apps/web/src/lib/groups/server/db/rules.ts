// The schema's refusals, as `GroupRuleError`, so the D1 modules never check its rules again.
import { errorText } from '../errors';

/** `reason` is a stable tag, so a route can map it without matching the message. */
export class GroupRuleError extends Error {
	constructor(
		readonly reason: 'did-taken' | 'not-found' | 'already-pending' | 'invite-only' | 'constraint',
		message: string
	) {
		super(message);
		this.name = 'GroupRuleError';
	}
}

// SQLite names the columns of a violated unique index, not the index, and D1 wraps
// the same text.
export function constraintMessage(e: unknown): GroupRuleError | null {
	const text = errorText(e);
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

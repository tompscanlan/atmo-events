// The read rules as a pure predicate set. The group pages gate on them, and so
// does every remote form (`groupRequestContext` in ./remote-context.ts turns a group the
// caller cannot see into a 404). A regression here would let anyone learn that
// a private group exists, which is why these are tested directly and not only
// through a route.
//
// They are membership tests, not permission tests: read access is not
// something a group grants. So the fixtures carry a roster row and no
// permissions at all. The visibility is an argument, the host's answer
// (`readGroupVisibility`), because the gate never reads it off our row.
import { describe, it, expect } from 'vitest';
import { canSeeGroup, canSeeMembers } from './access';
import type { GroupRoleName } from './permissions';
import type { CallerMembership } from './types';

function membership(role: GroupRoleName | null): CallerMembership {
	return {
		did: role ? 'did:plc:alice' : null,
		role,
		pendingRequestId: null,
		// Deliberately empty: a read gate that consulted these would be the bug.
		permissions: new Set(),
		onRoster: role !== null
	};
}

const STRANGER = membership(null);

// The predicates ask `onRoster`, which the loader takes from the membership
// record whenever the records can answer, and never `role`, which is always the
// row's. The two disagree after a revocation whose row delete failed, and that
// is exactly when reading `role` would leak. `canSeeMembers` takes no
// visibility at all, which is what keeps a public group's roster members-only.
describe('the roster is what the loader says, not the row', () => {
	const revoked = { ...membership('admin'), onRoster: false };
	const recorded = { ...membership(null), did: 'did:plc:alice', onRoster: true };

	it('closes a group the host reads as private to a stranger, and to a DID whose row survived its revoked record', () => {
		expect(canSeeGroup('private', STRANGER)).toBe(false);
		expect(canSeeGroup('private', revoked)).toBe(false);
		expect(canSeeMembers(revoked)).toBe(false);
	});

	it('opens it to a DID the records put on the roster before any row exists, and a public host to everyone', () => {
		expect(canSeeGroup('private', recorded)).toBe(true);
		expect(canSeeMembers(recorded)).toBe(true);
		for (const caller of [STRANGER, revoked, recorded, membership('member')]) {
			expect(canSeeGroup('public', caller)).toBe(true);
		}
	});
});

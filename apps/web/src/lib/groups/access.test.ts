// The read rules as a pure predicate set. The group pages gate on them, and so
// does every remote form (`context()` in ./groups.remote.ts turns a group the
// caller cannot see into a 404). A regression here would let anyone learn that
// a private group exists, which is why these are tested directly and not only
// through a route.
//
// They are membership tests, not permission tests: read access is not
// something a group grants. So the fixtures carry a roster row and no
// permissions at all.
import { describe, it, expect } from 'vitest';
import { canSeeGroup, canSeeMembers } from './access';
import type { GroupRoleName } from './permissions';
import type { CallerMembership, GroupRow } from './types';

function membership(role: GroupRoleName | null): CallerMembership {
	return {
		did: role ? 'did:plc:alice' : null,
		role,
		status: role ? 'active' : null,
		pendingRequestId: null,
		// Deliberately empty: a read gate that consulted these would be the bug.
		permissions: new Set(),
		onRoster: role !== null
	};
}

function group(visibility: GroupRow['visibility']): GroupRow {
	return { visibility } as GroupRow;
}

const STRANGER = membership(null);

describe('canSeeGroup', () => {
	it('hides only private groups from a stranger', () => {
		// Two visibilities, so this predicate is the whole of the read rule: a
		// group is either open to a stranger or it is not.
		expect(canSeeGroup(group('public'), STRANGER)).toBe(true);
		expect(canSeeGroup(group('private'), STRANGER)).toBe(false);
	});

	it('opens a private group to anyone on the roster, whatever the role', () => {
		expect(canSeeGroup(group('private'), membership('member'))).toBe(true);
		expect(canSeeGroup(group('private'), membership('admin'))).toBe(true);
	});
});

// The predicates ask `onRoster`, which the loader takes from the membership
// record whenever the records can answer, and never `role`, which is always the
// row's. The two disagree after a revocation whose row delete failed, and that
// is exactly when reading `role` would leak.
describe('the roster is what the loader says, not the row', () => {
	it('closes a private group to a DID whose row survived its revoked record', () => {
		const revoked = { ...membership('admin'), onRoster: false };
		expect(canSeeGroup(group('private'), revoked)).toBe(false);
		expect(canSeeMembers(revoked)).toBe(false);
	});

	it('opens it to a DID the records put on the roster before any row exists', () => {
		const recorded = { ...membership(null), did: 'did:plc:alice', onRoster: true };
		expect(canSeeGroup(group('private'), recorded)).toBe(true);
		expect(canSeeMembers(recorded)).toBe(true);
	});
});

describe('canSeeMembers', () => {
	it('gates the roster regardless of visibility, including a public group', () => {
		// There is no visibility branch here at all, which is what makes a public
		// group's roster members-only.
		expect(canSeeMembers(STRANGER)).toBe(false);
		expect(canSeeMembers(membership('member'))).toBe(true);
	});
});

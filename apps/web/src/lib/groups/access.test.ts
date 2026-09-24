// The read rules as a pure predicate set. They are load-bearing twice over:
// the group pages gate on them, and since om-5oxc8 so does every remote form
// (`context()` in ../groups.remote.ts turns an invisible group into a 404). A
// regression here reopens a private group's existence oracle, which is why
// these are asserted directly rather than only through a route.
//
// Since FR-005d they are MEMBERSHIP tests, not permission tests: read access
// is not something a group grants. The fixtures therefore carry a roster row
// and no permissions at all.
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
		// group is either open to a stranger or it is not (FR-016d).
		expect(canSeeGroup(group('public'), STRANGER)).toBe(true);
		expect(canSeeGroup(group('private'), STRANGER)).toBe(false);
	});

	it('opens a private group to anyone on the roster, whatever the role', () => {
		expect(canSeeGroup(group('private'), membership('member'))).toBe(true);
		expect(canSeeGroup(group('private'), membership('admin'))).toBe(true);
	});
});

// FR-005d, TS 2026-09-23: the predicates ask `onRoster`, which the loader
// takes from the membership RECORD whenever the records can answer, and never
// `role`, which is always the row's. The two disagree after a revocation whose
// row delete failed, and that is exactly when reading `role` would leak.
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
		// There is no visibility branch here at all, which is what makes a PUBLIC
		// group's roster members-only (FR-016b).
		expect(canSeeMembers(STRANGER)).toBe(false);
		expect(canSeeMembers(membership('member'))).toBe(true);
	});
});

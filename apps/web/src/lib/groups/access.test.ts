// The read rules as a pure predicate set. They are load-bearing twice over:
// the group pages gate on them, and since om-5oxc8 so does every remote form
// (`context()` in ../groups.remote.ts turns an invisible group into a 404). A
// regression here reopens a private group's existence oracle, which is why
// these are asserted directly rather than only through a route.
import { describe, it, expect } from 'vitest';
import { canSeeGroup, canSeeGroupEvents, canSeeMembers } from './access';
import { DEFAULT_ROLE_PERMISSIONS, type GroupPermission, type GroupRoleName } from './permissions';
import type { CallerMembership, GroupRow } from './types';

function membership(role: GroupRoleName | null, overrides: GroupPermission[] = []): CallerMembership {
	return {
		did: role ? 'did:plc:alice' : null,
		role,
		status: role ? 'active' : null,
		pendingRequestId: null,
		permissions: new Set(role ? [...DEFAULT_ROLE_PERMISSIONS[role], ...overrides] : overrides)
	};
}

function group(visibility: GroupRow['visibility']): GroupRow {
	return { visibility } as GroupRow;
}

const STRANGER = membership(null);

describe('canSeeGroup', () => {
	it('hides only private groups from a stranger', () => {
		expect(canSeeGroup(group('public'), STRANGER)).toBe(true);
		// Unlisted is reachable by URL on purpose — it is absent from the browse
		// list, not gated (see listGroups).
		expect(canSeeGroup(group('unlisted'), STRANGER)).toBe(true);
		expect(canSeeGroup(group('private'), STRANGER)).toBe(false);
	});

	it('opens a private group to a member, on the permission and not the roster row', () => {
		expect(canSeeGroup(group('private'), membership('member'))).toBe(true);
		// A `guest` holds CONTACT_ADMINS alone, so a roster row is NOT the rule —
		// this is where the predicate is deliberately stricter than the browse
		// query, which admits any active membership regardless of role.
		expect(canSeeGroup(group('private'), membership('guest'))).toBe(false);
	});
});

describe('canSeeGroupEvents', () => {
	it('follows the page rule for public and unlisted, and SEE_EVENTS for private', () => {
		expect(canSeeGroupEvents(group('unlisted'), STRANGER)).toBe(true);
		expect(canSeeGroupEvents(group('private'), STRANGER)).toBe(false);
		expect(canSeeGroupEvents(group('private'), membership('member'))).toBe(true);
		expect(canSeeGroupEvents(group('private'), membership('guest'))).toBe(false);
	});
});

describe('canSeeMembers', () => {
	it('gates the roster regardless of visibility, including a public group', () => {
		// The one SEE_* name that does work outside a private group: there is no
		// visibility branch here at all, so a public group's roster is members-only
		// too. Recorded 2026-09-17; it is why SEE_MEMBERS cannot be pared with the
		// other two (om-ci0ol).
		expect(canSeeMembers(STRANGER)).toBe(false);
		expect(canSeeMembers(membership('member'))).toBe(true);
		expect(canSeeMembers(membership('guest'))).toBe(false);
	});
});

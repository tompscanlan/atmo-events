import { describe, it, expect } from 'vitest';
import { canSeeGroup, canSeeMembers } from './access';
import type { GroupRoleName } from './permissions';
import type { CallerMembership } from './types';
import { NO_GRANTS } from './scopes';

function membership(role: GroupRoleName | null): CallerMembership {
	return {
		did: role ? 'did:plc:alice' : null,
		role,
		pendingRequestId: null,
		permissions: new Set(),
		grants: NO_GRANTS,
		onRoster: role !== null
	};
}

const STRANGER = membership(null);

// The gate asks `onRoster`, from the records, never the row's `role`.
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

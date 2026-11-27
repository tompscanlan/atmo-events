import { describe, expect, it } from 'vitest';
import { membershipDid, membershipRkey } from './ids';
import {
	defaultRoles,
	membershipRecord,
	membershipRoles,
	roleOf,
	rolesWithAdmin,
	shownRoles
} from './roster';

describe('a membership', () => {
	it('always holds member, keeps roles this site does not change, and makes or unmakes an admin', () => {
		expect(rolesWithAdmin(['member'], true)).toEqual(['member', 'admin']);
		expect(rolesWithAdmin(['admin', 'member', 'rider'], false)).toEqual(['member', 'rider']);
		expect(rolesWithAdmin(['rider'], false)).toEqual(['member', 'rider']);
		expect(rolesWithAdmin(['admin'], true)).toEqual(['member', 'admin']);
	});

	it('gives on request the roles marked default, as the group host does on an open join', () => {
		const marked = (rkey: string, mark: unknown = true) => ({ rkey, value: { default: mark } });
		// None marked: `member`.
		expect(defaultRoles([marked('admin', false), { rkey: 'member', value: {} }])).toEqual([
			'member'
		]);
		// In the order listed, `member` where it is listed.
		expect(defaultRoles([marked('aide'), marked('member'), marked('rider')])).toEqual([
			'aide',
			'member',
			'rider'
		]);
		// `member` first when it is not marked.
		expect(defaultRoles([marked('rider'), marked('admin', 'true')])).toEqual(['member', 'rider']);
	});

	it("is the spec's record, with no member field", () => {
		expect(membershipRecord(['member'], '2026-11-01T00:00:00Z')).toEqual({
			$type: 'org.atgrp.membership',
			roles: ['member'],
			createdAt: '2026-11-01T00:00:00Z'
		});
	});

	it('reads its roles once each, and none from a record without a list', () => {
		expect(membershipRoles({ roles: ['member', 'admin', 'member', 3, ''] })).toEqual([
			'member',
			'admin'
		]);
		expect(membershipRoles({ createdAt: 'x' })).toBeNull();
		expect(membershipRoles(null)).toBeNull();
	});

	it("is keyed by the member's DID, a did:web port written plain, and read back encoded", () => {
		for (const did of ['did:plc:bob', 'did:web:pds.example%3A8443', 'did:web:a.example']) {
			expect(membershipDid(membershipRkey(did))).toBe(did);
		}
		expect(membershipDid('did:web:pds.example:8443:u:bob')).toBe(
			'did:web:pds.example%3A8443:u:bob'
		);
		expect(membershipDid('did:web:pds.example:u:bob')).toBe('did:web:pds.example:u:bob');
	});
});

describe('a role', () => {
	it('is named by its displayName, or its ID', () => {
		expect(roleOf({ displayName: ' Riders ' }, 'rider')).toEqual({ id: 'rider', name: 'Riders' });
		expect(roleOf({}, 'rider')).toEqual({ id: 'rider', name: 'rider' });
	});

	it('is shown for each role a member holds beyond member, named or not', () => {
		const roles = [{ id: 'admin', name: 'Admin' }];
		expect(shownRoles({ roles: ['member', 'admin', 'bot'] }, roles)).toEqual([
			{ id: 'admin', name: 'Admin' },
			{ id: 'bot', name: 'bot' }
		]);
	});
});

// The roster record shapes. Three things here are load-bearing rather than
// plumbing:
//
//   1. the record KEY is the member's DID, so a DID that is not a legal record
//      key has to be refused here and not by a PDS 400 three layers down;
//   2. the KEY wins over a disagreeing `subject` field, because the key is what
//      the host addresses the record by — trusting the field would let a record
//      grant roles to somebody it was not filed under;
//   3. an unknown role is dropped rather than carried, so a record written by a
//      build with a bigger vocabulary cannot grant a role this build cannot
//      resolve. A record left with NO known role grants nothing, which is the
//      same answer as no record at all.
import { describe, it, expect } from 'vitest';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	MEMBERS_SPACE_READER_ROLES,
	MembershipKeyError,
	groupAccessRecord,
	groupMembershipRecord,
	isMembershipKey,
	membershipRkey,
	parseGroupAccess,
	parseGroupMembership
} from './members-record';

const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';

describe('membershipRkey', () => {
	it('uses a did:plc verbatim, so the record is addressable by the member DID', () => {
		expect(membershipRkey(MEMBER)).toBe(MEMBER);
		expect(isMembershipKey(MEMBER)).toBe(true);
	});

	it('refuses a DID the record-key syntax cannot hold', () => {
		// A did:web carrying a percent-encoded port: `%` is outside the record-key
		// character set, so this record could never be written or read back.
		expect(() => membershipRkey('did:web:example.com%3A3000')).toThrow(MembershipKeyError);
		expect(isMembershipKey('did:web:example.com%3A3000')).toBe(false);
	});
});

describe('groupMembershipRecord', () => {
	it('carries the subject and its roles, and stamps a date when none is given', () => {
		const record = groupMembershipRecord({ subject: MEMBER, roles: ['admin'] });
		expect(record.subject).toBe(MEMBER);
		expect(record.roles).toEqual(['admin']);
		expect(typeof record.createdAt).toBe('string');
	});

	it('preserves a supplied date, so a promotion does not restamp the join date', () => {
		const record = groupMembershipRecord({
			subject: MEMBER,
			roles: ['admin'],
			createdAt: '2026-09-01T12:00:00.000Z'
		});
		expect(record.createdAt).toBe('2026-09-01T12:00:00.000Z');
	});

	it('drops a role outside the vocabulary and orders the rest most-privileged first', () => {
		const record = groupMembershipRecord({
			subject: MEMBER,
			// `moderator` was dropped by FR-005c, so a caller still passing it is
			// exactly the stale case this filter exists for.
			roles: ['member', 'moderator', 'owner'] as never
		});
		expect(record.roles).toEqual(['owner', 'member']);
	});

	it('carries no status field: a suspension revokes the record instead', () => {
		expect(groupMembershipRecord({ subject: MEMBER, roles: ['member'] })).not.toHaveProperty(
			'status'
		);
	});
});

describe('parseGroupMembership', () => {
	it('prefers the record KEY over a subject field that disagrees with it', () => {
		const parsed = parseGroupMembership(
			{ subject: 'did:plc:someone-else', roles: ['admin'] },
			MEMBER
		);
		expect(parsed?.subject).toBe(MEMBER);
	});

	it('falls back to the subject field when the record came without its key', () => {
		expect(parseGroupMembership({ subject: MEMBER, roles: ['member'] })?.subject).toBe(MEMBER);
	});

	it('reads a record with no role we know as granting nothing', () => {
		const parsed = parseGroupMembership({ subject: MEMBER, roles: ['greeter'] }, MEMBER);
		expect(parsed?.roles).toEqual([]);
	});

	it('is null for a value that names nobody', () => {
		expect(parseGroupMembership({ roles: ['member'] })).toBeNull();
		expect(parseGroupMembership('not a record', MEMBER)).toBeNull();
	});

	it('round-trips what the builder wrote', () => {
		const record = groupMembershipRecord({ subject: MEMBER, roles: ['admin'] });
		const parsed = parseGroupMembership(record, MEMBER);
		expect(parsed).toEqual({
			subject: MEMBER,
			roles: ['admin'],
			createdAt: record.createdAt
		});
	});
});

describe('groupAccessRecord', () => {
	it('names every role as a reader, because the roster is members-only at every visibility', () => {
		const record = groupAccessRecord({ roles: MEMBERS_SPACE_READER_ROLES });
		expect(record.roles).toEqual(['owner', 'admin', 'member']);
	});

	it('carries no OAuth scopes: no authorization server can issue them yet', () => {
		expect(groupAccessRecord({ roles: ['owner'] })).not.toHaveProperty('scopes');
	});

	it('carries no visibility: three visibilities do not invert from a role list', () => {
		expect(groupAccessRecord({ roles: ['owner'] })).not.toHaveProperty('visibility');
	});

	it('parses back, dropping roles outside the vocabulary', () => {
		expect(parseGroupAccess({ roles: ['owner', 'guest'] })?.roles).toEqual(['owner']);
	});

	it('is null when there is no roles list at all, rather than defaulting to open', () => {
		expect(parseGroupAccess({ createdAt: '2026-09-01T12:00:00.000Z' })).toBeNull();
	});
});

describe('collections', () => {
	it('publishes under the prefix FR-013 fixed, with the draft’s leaf names', () => {
		expect(GROUP_MEMBERSHIP_COLLECTION).toBe('net.openmeet.group.membership');
		expect(GROUP_ACCESS_COLLECTION).toBe('net.openmeet.group.access');
	});
});

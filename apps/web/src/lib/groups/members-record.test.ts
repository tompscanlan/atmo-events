// The roster record shapes. Three rules here matter:
//
//   1. the record key is the member's DID, so a DID that is not a legal record
//      key has to be refused here and not by a PDS 400 three layers down;
//   2. the key wins over a disagreeing `subject` field, because the key is what
//      the host addresses the record by. Trusting the field would let a record
//      grant roles to somebody it was not filed under;
//   3. an unknown role is dropped rather than carried, so a record written by a
//      build with a bigger vocabulary cannot grant a role this build cannot
//      resolve. A record left with no known role grants nothing, which is the
//      same answer as no record at all.
import { describe, it, expect } from 'vitest';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_ROLE_COLLECTION,
	MEMBERS_SPACE_READER_ROLES,
	MembershipKeyError,
	groupAccessRecord,
	groupBindingsRecord,
	groupMembershipRecord,
	groupRoleRecord,
	isMembershipKey,
	membershipRkey,
	parseGroupAccess,
	parseGroupBindings,
	parseGroupMembership,
	parseGroupRole
} from './members-record';
import { DEFAULT_ROLE_PERMISSIONS } from './permissions';

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
			// `moderator` is not a role in this build, so a caller passing it is
			// exactly the stale case this filter exists for.
			roles: ['member', 'moderator', 'owner'] as never
		});
		expect(record.roles).toEqual(['owner', 'member']);
	});

	it('carries no status field: revoking a membership deletes the record instead', () => {
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

	it('carries no visibility: visibility does not invert from a role list', () => {
		expect(groupAccessRecord({ roles: ['owner'] })).not.toHaveProperty('visibility');
	});

	it('parses back, dropping roles outside the vocabulary', () => {
		expect(parseGroupAccess({ roles: ['owner', 'guest'] })?.roles).toEqual(['owner']);
	});

	it('is null when there is no roles list at all, rather than defaulting to open', () => {
		expect(parseGroupAccess({ createdAt: '2026-09-01T12:00:00.000Z' })).toBeNull();
	});
});

describe('groupRoleRecord', () => {
	it('repeats its id in the body, so a record lifted out of its key is not anonymous', () => {
		expect(groupRoleRecord({ id: 'admin' })).toMatchObject({ id: 'admin' });
	});

	it('carries no permissions: what a role may do is the binding record’s answer', () => {
		expect(Object.keys(groupRoleRecord({ id: 'admin' })).sort()).toEqual(['createdAt', 'id']);
	});

	it('prefers the key over a disagreeing id, because the key is what the host addresses', () => {
		expect(parseGroupRole({ id: 'owner' }, 'member')?.id).toBe('member');
	});

	it('is null for a role outside this build’s vocabulary', () => {
		expect(parseGroupRole({ id: 'greeter' }, 'greeter')).toBeNull();
	});
});

describe('groupBindingsRecord', () => {
	it('splits one bundle across the two altitudes, publishing each in its own dialect', () => {
		const bundles = { owner: DEFAULT_ROLE_PERMISSIONS.owner };
		expect(groupBindingsRecord({ altitude: 'community', bundles }).bindings).toEqual([
			{ role: 'owner', actions: ['community.configure', 'admit', 'eject', 'role.assign'] }
		]);
		expect(groupBindingsRecord({ altitude: 'modality', bundles }).bindings).toEqual([
			{ role: 'owner', actions: ['manageEvents', 'createEvent'] }
		]);
	});

	it('writes a bound-to-nothing role rather than omitting it', () => {
		expect(
			groupBindingsRecord({ altitude: 'community', bundles: { member: [] } }).bindings
		).toEqual([{ role: 'member', actions: [] }]);
	});

	it('unions a repeated role rather than letting the last binding win', () => {
		// The model has no precedence, so "the later row wins" would be a rule
		// this record invented.
		const parsed = parseGroupBindings('community', {
			bindings: [
				{ role: 'admin', actions: ['admit'] },
				{ role: 'admin', actions: ['eject'] }
			]
		});
		expect(parsed?.bindings).toEqual([
			{ role: 'admin', permissions: ['ADMIT_MEMBERS', 'EJECT_MEMBERS'] }
		]);
	});

	it('is null without a bindings list, rather than an empty authz config', () => {
		// An absent record and a record binding nothing must stay distinguishable:
		// one is a group with no authz config yet, the other is a group that
		// granted nothing on purpose.
		expect(parseGroupBindings('community', { createdAt: '2026-09-20T12:00:00.000Z' })).toBeNull();
		expect(parseGroupBindings('community', { bindings: [] })?.bindings).toEqual([]);
	});
});

describe('collections', () => {
	it('publishes under our own prefix, with the draft’s leaf names', () => {
		expect(GROUP_MEMBERSHIP_COLLECTION).toBe('net.openmeet.group.membership');
		expect(GROUP_ACCESS_COLLECTION).toBe('net.openmeet.group.access');
		expect(GROUP_ROLE_COLLECTION).toBe('net.openmeet.group.role');
		expect(GROUP_PERMISSIONS_COLLECTION).toBe('net.openmeet.group.permissions');
	});

	it('keeps the modality binding on a leaf of OUR own, not on the community record', () => {
		// The community record must stay swappable onto an upstream collection
		// name, so the event actions cannot ride on it.
		expect(GROUP_EVENT_PERMISSIONS_COLLECTION).toBe('net.openmeet.group.eventPermissions');
		expect(GROUP_EVENT_PERMISSIONS_COLLECTION).not.toBe(GROUP_PERMISSIONS_COLLECTION);
	});
});

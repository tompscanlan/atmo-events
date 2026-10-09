// The roster record shapes. Three rules here matter:
//
//   1. the record key is the member's DID, so a DID that is not a legal record
//      key has to be refused here and not by a PDS 400 three layers down;
//   2. the key wins over a disagreeing `member` field, because the key is what
//      the host addresses the record by. Trusting the field would let a record
//      grant roles to somebody it was not filed under;
//   3. an unknown role is dropped rather than carried, so a record written by a
//      build with a bigger vocabulary cannot grant a role this build cannot
//      resolve. A record left with no known role grants nothing, which is the
//      same answer as no record at all.
import { describe, it, expect } from 'vitest';
import {
	MembershipKeyError,
	accessSays,
	groupBindingsRecord,
	groupMembershipRecord,
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
	it('drops a role outside the vocabulary and orders the rest most-privileged first', () => {
		const record = groupMembershipRecord({
			subject: MEMBER,
			// `moderator` is not a role in this build, so a caller passing it is
			// exactly the stale case this filter exists for.
			roles: ['member', 'moderator', 'owner'] as never
		});
		expect(record.roles).toEqual(['owner', 'member']);
	});
});

describe('parseGroupMembership', () => {
	it('prefers the record KEY over a member field that disagrees with it', () => {
		const parsed = parseGroupMembership(
			{ member: 'did:plc:someone-else', roles: ['admin'] },
			MEMBER
		);
		expect(parsed?.subject).toBe(MEMBER);
	});

	it('reads a record with no role we know as granting nothing', () => {
		const parsed = parseGroupMembership({ member: MEMBER, roles: ['greeter'] }, MEMBER);
		expect(parsed?.roles).toEqual([]);
	});

	it('is null for a value that names nobody', () => {
		expect(parseGroupMembership({ roles: ['member'] })).toBeNull();
		expect(parseGroupMembership('not a record', MEMBER)).toBeNull();
	});
});

describe('parseGroupAccess', () => {
	it('parses back, dropping roles outside the vocabulary', () => {
		expect(parseGroupAccess({ public: false, readRoles: ['owner', 'guest'] })?.roles).toEqual([
			'owner'
		]);
	});

	it('is null when there is no readRoles list at all, rather than defaulting to open', () => {
		expect(parseGroupAccess({ public: false, grants: [] })).toBeNull();
	});
});

describe('accessSays', () => {
	// A missing record says nothing, so a writer that asks writes one.
	it('is false for a missing record, whatever it is asked', () => {
		expect(accessSays(null, true)).toBe(false);
		expect(accessSays(null, false)).toBe(false);
	});
});

describe('parseGroupRole', () => {
	it('takes its id from the key, because the key is what the host addresses', () => {
		expect(parseGroupRole({ displayName: 'Owner' }, 'member')?.id).toBe('member');
	});

	it('is null for a role outside this build’s vocabulary, or with no key', () => {
		expect(parseGroupRole({ displayName: 'Greeter' }, 'greeter')).toBeNull();
		expect(parseGroupRole({ displayName: 'Admin' })).toBeNull();
	});
});

describe('groupBindingsRecord', () => {
	// `assignable` bounds both role.assign and eject. Only the owner's binding
	// lists `owner`, so no admin can assign or eject the owner.
	it('lets the owner assign every role, an admin every role but owner, and a member none', () => {
		const record = groupBindingsRecord({
			altitude: 'community',
			bundles: DEFAULT_ROLE_PERMISSIONS
		});
		expect(record.roles).toEqual([
			{
				role: 'owner',
				actions: ['group.configure', 'admit', 'eject', 'role.assign'],
				assignable: ['owner', 'admin', 'member']
			},
			{
				role: 'admin',
				actions: ['group.configure', 'admit', 'eject', 'role.assign'],
				assignable: ['admin', 'member']
			},
			{ role: 'member', actions: [], assignable: [] }
		]);
		expect(record.defaultRoles).toEqual(['member']);
	});

	it('unions a repeated role rather than letting the last binding win', () => {
		// The model has no precedence, so "the later row wins" would be a rule
		// this record invented.
		const parsed = parseGroupBindings('community', {
			roles: [
				{ role: 'admin', actions: ['admit'], assignable: [] },
				{ role: 'admin', actions: ['eject'], assignable: [] }
			],
			defaultRoles: []
		});
		expect(parsed?.bindings).toEqual([
			{ role: 'admin', permissions: ['ADMIT_MEMBERS', 'EJECT_MEMBERS'] }
		]);
	});

	it('is null without a roles list, rather than an empty authz config', () => {
		// An absent record and a record binding nothing must stay distinguishable:
		// one is a group with no authz config yet, the other is a group that
		// granted nothing on purpose.
		expect(parseGroupBindings('community', { defaultRoles: ['member'] })).toBeNull();
		expect(parseGroupBindings('community', { roles: [], defaultRoles: [] })?.bindings).toEqual([]);
		expect(parseGroupBindings('modality', { createdAt: '2026-09-20T12:00:00.000Z' })).toBeNull();
		expect(parseGroupBindings('modality', { bindings: [] })?.bindings).toEqual([]);
	});
});

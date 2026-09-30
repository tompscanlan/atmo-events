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
	it('carries the member and its roles, and stamps a date when none is given', () => {
		const record = groupMembershipRecord({ subject: MEMBER, roles: ['admin'] });
		expect(record.member).toBe(MEMBER);
		expect(record.roles).toEqual(['admin']);
		expect(typeof record.createdAt).toBe('string');
		expect(Object.keys(record).sort()).toEqual(['createdAt', 'member', 'roles']);
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
	it('prefers the record KEY over a member field that disagrees with it', () => {
		const parsed = parseGroupMembership(
			{ member: 'did:plc:someone-else', roles: ['admin'] },
			MEMBER
		);
		expect(parsed?.subject).toBe(MEMBER);
	});

	it('falls back to the member field when the record came without its key', () => {
		expect(parseGroupMembership({ member: MEMBER, roles: ['member'] })?.subject).toBe(MEMBER);
	});

	it('reads a record with no role we know as granting nothing', () => {
		const parsed = parseGroupMembership({ member: MEMBER, roles: ['greeter'] }, MEMBER);
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
		expect(record.readRoles).toEqual(['owner', 'admin', 'member']);
	});

	// The members space is never public, whatever the group's visibility.
	it('is not public', () => {
		expect(groupAccessRecord({ roles: MEMBERS_SPACE_READER_ROLES }).public).toBe(false);
	});

	it('grants no OAuth scopes: no authorization server can issue them yet', () => {
		expect(groupAccessRecord({ roles: ['owner'] }).grants).toEqual([]);
	});

	it('carries nothing but the three fields the standard requires', () => {
		expect(Object.keys(groupAccessRecord({ roles: ['owner'] })).sort()).toEqual([
			'grants',
			'public',
			'readRoles'
		]);
	});

	it('parses back, dropping roles outside the vocabulary', () => {
		expect(parseGroupAccess({ public: false, readRoles: ['owner', 'guest'] })?.roles).toEqual([
			'owner'
		]);
	});

	it('is null when there is no readRoles list at all, rather than defaulting to open', () => {
		expect(parseGroupAccess({ public: false, grants: [] })).toBeNull();
	});
});

describe('groupRoleRecord', () => {
	it('names the role for display, derived from its id', () => {
		expect(groupRoleRecord({ id: 'owner' })).toEqual({ displayName: 'Owner' });
		expect(groupRoleRecord({ id: 'admin' })).toEqual({ displayName: 'Admin' });
		expect(groupRoleRecord({ id: 'member' })).toEqual({ displayName: 'Member' });
	});

	it('takes its id from the key, because the key is what the host addresses', () => {
		expect(parseGroupRole({ displayName: 'Owner' }, 'member')?.id).toBe('member');
	});

	it('is null for a role outside this build’s vocabulary, or with no key', () => {
		expect(parseGroupRole({ displayName: 'Greeter' }, 'greeter')).toBeNull();
		expect(parseGroupRole({ displayName: 'Admin' })).toBeNull();
	});
});

describe('groupBindingsRecord', () => {
	it('splits one bundle across the two altitudes, publishing each in its own dialect', () => {
		const bundles = { owner: DEFAULT_ROLE_PERMISSIONS.owner };
		expect(groupBindingsRecord({ altitude: 'community', bundles }).roles).toEqual([
			{
				role: 'owner',
				actions: ['group.configure', 'admit', 'eject', 'role.assign'],
				assignable: ['owner']
			}
		]);
		expect(groupBindingsRecord({ altitude: 'modality', bundles }).bindings).toEqual([
			{ role: 'owner', actions: ['manageEvents', 'createEvent'] }
		]);
	});

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

	it('carries only the standard’s two fields on the community record', () => {
		const record = groupBindingsRecord({
			altitude: 'community',
			bundles: DEFAULT_ROLE_PERMISSIONS
		});
		expect(Object.keys(record).sort()).toEqual(['defaultRoles', 'roles']);
	});

	// Every role the record names must be one it binds, or a reader rejects it.
	it('names no role in assignable or defaultRoles that it does not bind', () => {
		const record = groupBindingsRecord({
			altitude: 'community',
			bundles: { owner: DEFAULT_ROLE_PERMISSIONS.owner }
		});
		expect(record.roles).toEqual([
			expect.objectContaining({ role: 'owner', assignable: ['owner'] })
		]);
		expect(record.defaultRoles).toEqual([]);
	});

	it('writes a bound-to-nothing role rather than omitting it', () => {
		expect(groupBindingsRecord({ altitude: 'community', bundles: { member: [] } }).roles).toEqual([
			{ role: 'member', actions: [], assignable: [] }
		]);
		expect(groupBindingsRecord({ altitude: 'modality', bundles: { member: [] } }).bindings).toEqual(
			[{ role: 'member', actions: [] }]
		);
	});

	it('keeps the event record’s own shape, with its date', () => {
		const record = groupBindingsRecord({
			altitude: 'modality',
			bundles: { member: [] },
			createdAt: '2026-09-20T12:00:00.000Z'
		});
		expect(record).toEqual({
			bindings: [{ role: 'member', actions: [] }],
			createdAt: '2026-09-20T12:00:00.000Z'
		});
	});

	it('round-trips both records through the parser', () => {
		const expected = {
			community: ['MANAGE_GROUP', 'ADMIT_MEMBERS', 'EJECT_MEMBERS', 'ASSIGN_ROLES'],
			modality: ['MANAGE_EVENTS', 'CREATE_EVENT']
		};
		for (const altitude of ['community', 'modality'] as const) {
			const record = groupBindingsRecord({ altitude, bundles: DEFAULT_ROLE_PERMISSIONS });
			expect(parseGroupBindings(altitude, record)?.bindings, altitude).toEqual([
				{ role: 'owner', permissions: expected[altitude] },
				{ role: 'admin', permissions: expected[altitude] },
				{ role: 'member', permissions: [] }
			]);
		}
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

describe('collections', () => {
	it('publishes the roster and authz config under the group.opensocial names', () => {
		expect(GROUP_MEMBERSHIP_COLLECTION).toBe('group.opensocial.membership');
		expect(GROUP_ACCESS_COLLECTION).toBe('group.opensocial.access');
		expect(GROUP_ROLE_COLLECTION).toBe('group.opensocial.role');
		expect(GROUP_PERMISSIONS_COLLECTION).toBe('group.opensocial.permissions');
	});

	it('keeps the event actions on a record of their own, not on the permissions record', () => {
		// The standard puts a modality's authz in the modality's own space, and
		// that space does not exist yet, so the event actions stay on their own
		// record rather than ride on the standard one.
		expect(GROUP_EVENT_PERMISSIONS_COLLECTION).toBe('net.openmeet.group.eventPermissions');
		expect(GROUP_EVENT_PERMISSIONS_COLLECTION).not.toBe(GROUP_PERMISSIONS_COLLECTION);
	});
});

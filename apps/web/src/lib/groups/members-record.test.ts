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
	accessGrantsRead,
	accessSays,
	groupAccessRecord,
	groupBindingsRecord,
	groupMembershipRecord,
	groupRoleRecord,
	isMembershipKey,
	membershipRkey,
	parseEventBindings,
	parseGroupAccess,
	parseGroupGrants,
	parseGroupMembership,
	parseGroupRole
} from './members-record';
import { DEFAULT_ROLE_PERMISSIONS, PUBLISHED_SCOPES } from './permissions';

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
			// `owner` is no longer one either (TS, 2026-10-20).
			roles: ['member', 'moderator', 'owner', 'admin'] as never
		});
		expect(record.roles).toEqual(['admin', 'member']);
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

	it('reads a record with no role we know as no roster role, keeping its ids for the gate', () => {
		const parsed = parseGroupMembership({ member: MEMBER, roles: ['greeter'] }, MEMBER);
		expect(parsed?.roles).toEqual([]);
		// The write gate still sees it, since a role this build does not know has
		// grants of its own and bounds who may eject its holder.
		expect(parsed?.roleIds).toEqual(['greeter']);
	});

	it('is null for a value that names nobody', () => {
		expect(parseGroupMembership({ roles: ['member'] })).toBeNull();
		expect(parseGroupMembership('not a record', MEMBER)).toBeNull();
	});
});

describe('groupAccessRecord', () => {
	it('grants each reader role read on the space, by its type, and nothing more', () => {
		const record = groupAccessRecord({
			spaceType: 'group.opensocial.members',
			roles: ['admin', 'member'],
			public: false
		});
		expect(record).toEqual({
			public: false,
			grants: [
				{ role: 'admin', scopes: ['space:group.opensocial.members?action=read'] },
				{ role: 'member', scopes: ['space:group.opensocial.members?action=read'] }
			]
		});
	});
});

describe('parseGroupAccess', () => {
	it('parses back the roles it writes', () => {
		const record = groupAccessRecord({
			spaceType: 'group.opensocial.meta',
			roles: ['admin', 'member'],
			public: true
		});
		expect(parseGroupAccess(record)).toEqual({
			roles: ['admin', 'member'],
			public: true,
			grants: record.grants
		});
	});

	// A reader is a role with a `space:` scope that reads, by naming `read` or by
	// naming no action at all. A write-only grant, or one outside the vocabulary,
	// makes no reader.
	it('counts only grants that read, and drops roles outside the vocabulary', () => {
		const parsed = parseGroupAccess({
			grants: [
				{ role: 'owner', scopes: ['space:group.opensocial.members'] },
				{ role: 'admin', scopes: ['space:group.opensocial.members?action=read&action=create'] },
				{ role: 'member', scopes: ['space:group.opensocial.members?action=create'] },
				{ role: 'guest', scopes: ['space:group.opensocial.members?action=read'] }
			]
		});
		// `owner` is outside the vocabulary now, like `guest`.
		expect(parsed?.roles).toEqual(['admin']);
		expect(parsed?.public).toBe(false);
		// Every grant stays, for the write gate, the unknown role's included.
		expect(parsed?.grants.map((grant) => grant.role)).toEqual([
			'owner',
			'admin',
			'member',
			'guest'
		]);
	});

	it('is null when there is no grants list at all, rather than defaulting to open', () => {
		expect(parseGroupAccess({ public: false })).toBeNull();
	});
});

describe('accessSays', () => {
	// A missing record says nothing, so a writer that asks writes one.
	it('is false for a missing record, whatever it is asked', () => {
		expect(accessSays(null, true)).toBe(false);
		expect(accessSays(null, false)).toBe(false);
	});
});

// A member may read a space exactly when a role they hold is granted `read`
// there, as the host enforces the access record. (Spec: FR-214.) A role atmo
// does not know still counts: the record is the group's,
// and a role it grants read is a reader whatever this build calls it.
describe('accessGrantsRead', () => {
	const access = (grants: { role: string; scopes: string[] }[]) =>
		parseGroupAccess({ public: false, grants });

	it('grants no one for a missing record', () => {
		expect(accessGrantsRead(null, ['member', 'admin', 'owner'])).toBe(false);
	});

	it('grants a role whose scope names no action, which grants every action', () => {
		const read = access([{ role: 'member', scopes: ['space:group.opensocial.members'] }]);
		expect(accessGrantsRead(read, ['member'])).toBe(true);
	});

	it('grants a role whose scope names action=read', () => {
		const read = access([
			{ role: 'member', scopes: ['space:group.opensocial.members?action=read'] }
		]);
		expect(accessGrantsRead(read, ['member'])).toBe(true);
	});

	it('does not grant a role whose scopes name actions other than read', () => {
		const writeOnly = access([
			{
				role: 'member',
				scopes: ['space:group.opensocial.members?action=create&action=update', 'repo:foo']
			}
		]);
		expect(accessGrantsRead(writeOnly, ['member'])).toBe(false);
	});

	it('does not grant a role the record does not name', () => {
		const read = access([
			{ role: 'admin', scopes: ['space:group.opensocial.members?action=read'] }
		]);
		expect(accessGrantsRead(read, ['member'])).toBe(false);
		expect(accessGrantsRead(read, [])).toBe(false);
	});

	it('grants a role id this build does not know, when the record grants it read', () => {
		const read = access([
			{ role: 'moderator', scopes: ['space:group.opensocial.members?action=read'] }
		]);
		expect(read?.roles).toEqual([]);
		expect(accessGrantsRead(read, ['moderator'])).toBe(true);
	});

	it('grants a member any one of whose roles reads', () => {
		const read = access([{ role: 'admin', scopes: ['space:group.opensocial.meta?action=read'] }]);
		expect(accessGrantsRead(read, ['member', 'admin'])).toBe(true);
	});
});

describe('groupRoleRecord', () => {
	// The standard keeps the default role on the role itself.
	it('marks the role a new member gets as the default, and only that one', () => {
		expect(groupRoleRecord({ id: 'member' })).toEqual({ displayName: 'Member', default: true });
		expect(groupRoleRecord({ id: 'admin' })).toEqual({ displayName: 'Admin' });
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
	// `assignable` bounds assigning and ejecting alike. Only the owner's grant
	// lists `owner`, so no admin can assign or eject the owner.
	it('lets an admin assign every role, and a member none', () => {
		const record = groupBindingsRecord({
			altitude: 'community',
			bundles: DEFAULT_ROLE_PERMISSIONS
		});
		const manager = [
			...PUBLISHED_SCOPES.MANAGE_GROUP,
			...PUBLISHED_SCOPES.ADMIT_MEMBERS,
			...PUBLISHED_SCOPES.EJECT_MEMBERS,
			...PUBLISHED_SCOPES.ASSIGN_ROLES
		];
		expect(record).toEqual({
			grants: [
				{ role: 'admin', scopes: manager, assignable: ['admin', 'member'] },
				{ role: 'member', scopes: [], assignable: [] }
			]
		});
	});

	it('reads back the grants it writes, as written', () => {
		const record = groupBindingsRecord({
			altitude: 'community',
			bundles: DEFAULT_ROLE_PERMISSIONS
		});
		expect(parseGroupGrants(record)).toEqual(record.grants);
	});

	// The gate unions them (../scopes.ts), so neither may be lost here.
	it('keeps a repeated role and any role id, and drops an entry with no role', () => {
		const parsed = parseGroupGrants({
			grants: [
				{ role: 'admin', scopes: PUBLISHED_SCOPES.ADMIT_MEMBERS, assignable: [] },
				{ role: 'admin', scopes: PUBLISHED_SCOPES.EJECT_MEMBERS, assignable: [] },
				{ role: 'moderator', scopes: 'not a list' },
				{ scopes: PUBLISHED_SCOPES.MANAGE_GROUP }
			]
		});
		expect(parsed).toEqual([
			{ role: 'admin', scopes: PUBLISHED_SCOPES.ADMIT_MEMBERS, assignable: [] },
			{ role: 'admin', scopes: PUBLISHED_SCOPES.EJECT_MEMBERS, assignable: [] },
			{ role: 'moderator', scopes: [] }
		]);
	});

	it('unions a repeated role in eventPermissions rather than letting the last binding win', () => {
		// The model has no precedence, so "the later row wins" would be a rule
		// this record invented.
		const parsed = parseEventBindings({
			bindings: [
				{ role: 'admin', actions: ['createEvent'] },
				{ role: 'admin', actions: ['manageEvents'] }
			]
		});
		expect(parsed?.bindings).toEqual([
			{ role: 'admin', permissions: ['CREATE_EVENT', 'MANAGE_EVENTS'] }
		]);
	});

	it('is null without a grants list, rather than an empty authz config', () => {
		// An absent record and a record binding nothing must stay distinguishable:
		// one is a group with no authz config yet, the other is a group that
		// granted nothing on purpose. The old shape, with `roles`, is no grants list.
		expect(parseGroupGrants({ roles: [], defaultRoles: [] })).toBeNull();
		expect(parseGroupGrants({ grants: [] })).toEqual([]);
		expect(parseEventBindings({ createdAt: '2026-09-20T12:00:00.000Z' })).toBeNull();
		expect(parseEventBindings({ bindings: [] })?.bindings).toEqual([]);
	});
});

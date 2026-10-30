import { describe, it, expect } from 'vitest';
import {
	MembershipKeyError,
	accessSays,
	groupAccessRecord,
	groupMembershipRecord,
	isMembershipKey,
	membershipRkey,
	parseGroupAccess,
	parseGroupGrants,
	parseGroupMembership,
	parseGroupRole
} from './members-record';

const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';

describe('membershipRkey', () => {
	it('uses a did:plc verbatim, so the record is addressable by the member DID', () => {
		expect(membershipRkey(MEMBER)).toBe(MEMBER);
		expect(isMembershipKey(MEMBER)).toBe(true);
	});

	it('refuses a DID the record-key syntax cannot hold', () => {
		expect(() => membershipRkey('did:web:example.com%3A3000')).toThrow(MembershipKeyError);
		expect(isMembershipKey('did:web:example.com%3A3000')).toBe(false);
	});
});

describe('membership records', () => {
	it('keep every role id, known here or not, once each', () => {
		const record = groupMembershipRecord({
			subject: MEMBER,
			roles: ['moderator', 'admin', 'admin']
		});
		expect(record).toMatchObject({ member: MEMBER, roles: ['moderator', 'admin'] });
		expect(parseGroupMembership(record, MEMBER)?.roles).toEqual(['moderator', 'admin']);
	});

	it('take the subject from the record key over a member field that disagrees', () => {
		const parsed = parseGroupMembership(
			{ member: 'did:plc:someone-else', roles: ['admin'] },
			MEMBER
		);
		expect(parsed?.subject).toBe(MEMBER);
	});

	it.each([
		[{ roles: ['member'] }, undefined],
		['not a record', MEMBER]
	])('are null for %j, which names nobody', (value, rkey) =>
		expect(parseGroupMembership(value, rkey)).toBeNull()
	);
});

describe('access records', () => {
	it('grant each reader role read on the space, and parse back as written', () => {
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
		expect(parseGroupAccess(record)).toEqual(record);
	});

	it('are null without a grants list, rather than open', () => {
		expect(parseGroupAccess({ public: true })).toBeNull();
		expect(accessSays(null, true)).toBe(false);
		expect(accessSays(null, false)).toBe(false);
	});
});

describe('parseGroupGrants', () => {
	it('keeps a repeated role and any role id, and drops an entry with no role', () => {
		const admit = ['space:group.opensocial.members?collection=group.opensocial.membership'];
		expect(
			parseGroupGrants({
				grants: [
					{ role: 'admin', scopes: admit, assignable: [] },
					{ role: 'admin', scopes: ['repo:*'] },
					{ role: 'moderator', scopes: 'not a list' },
					{ scopes: admit }
				]
			})
		).toEqual([
			{ role: 'admin', scopes: admit, assignable: [] },
			{ role: 'admin', scopes: ['repo:*'] },
			{ role: 'moderator', scopes: [] }
		]);
	});

	it('tells a record that grants nothing from one with no grants list', () => {
		expect(parseGroupGrants({ grants: [] })).toEqual([]);
		expect(parseGroupGrants({ roles: [] })).toBeNull();
	});
});

describe('parseGroupRole', () => {
	it('takes its id from the record key, and is null without one', () => {
		expect(parseGroupRole({ displayName: 'Helper' }, 'helper')).toEqual({ id: 'helper' });
		expect(parseGroupRole({ displayName: 'Admin' })).toBeNull();
	});
});

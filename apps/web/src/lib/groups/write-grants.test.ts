import { describe, it, expect } from 'vitest';
import {
	GROUP_ITSELF,
	NO_GRANTS,
	allowsRepoWrite,
	allowsWrite,
	membershipAction,
	parseRepoScope,
	parseSpaceScope,
	permits,
	spacePermissions,
	withAccess,
	writeGrants,
	type SpaceWrite
} from './write-grants';
import { spaceWrite } from './grants';

const GROUP = 'did:plc:group';
const MEMBERS = 'group.opensocial.members';
const META = 'group.opensocial.meta';
const MEMBERSHIP = 'group.opensocial.membership';
const ACCESS = 'group.opensocial.access';

const allowedBy = (scope: string, write: SpaceWrite) =>
	spacePermissions([scope]).some((p) => permits(p, GROUP, write));

describe('parseSpaceScope', () => {
	it("fills 0016's defaults for what a scope leaves out", () => {
		expect(parseSpaceScope(`space:${MEMBERS}`)).toEqual({
			spaceType: MEMBERS,
			authority: 'self',
			skey: '*',
			collections: null,
			actions: ['read', 'create', 'update', 'delete'],
			manage: []
		});
	});

	it('reads repeated parameters', () => {
		const p = parseSpaceScope(
			`space:${MEMBERS}?collection=a.b.c&collection=d.e.f&action=create&action=delete&manage=update`
		);
		expect(p?.collections).toEqual(['a.b.c', 'd.e.f']);
		expect(p?.actions).toEqual(['create', 'delete']);
		expect(p?.manage).toEqual(['update']);
	});

	it('drops an action outside the grammar, so it grants less, never more', () => {
		expect(parseSpaceScope(`space:${MEMBERS}?action=write`)?.actions).toEqual([]);
	});

	it('is null for anything but a space scope', () => {
		expect(parseSpaceScope('repo:group.opensocial.membership')).toBeNull();
		expect(parseSpaceScope('space:')).toBeNull();
	});
});

describe('permits', () => {
	const create = spaceWrite(MEMBERS, MEMBERSHIP, 'create');

	it('lets a bare scope write the collections its space type declares', () => {
		expect(allowedBy(`space:${MEMBERS}`, create)).toBe(true);
		expect(allowedBy(`space:${MEMBERS}`, spaceWrite(MEMBERS, 'x.y.z', 'create'))).toBe(false);
	});

	it('gives a read scope no write', () => {
		expect(allowedBy(`space:${MEMBERS}?action=read`, create)).toBe(false);
	});

	it('holds a write to its action and collection', () => {
		const scope = `space:${MEMBERS}?collection=${MEMBERSHIP}&action=delete`;
		expect(allowedBy(scope, spaceWrite(MEMBERS, MEMBERSHIP, 'delete'))).toBe(true);
		expect(allowedBy(scope, spaceWrite(MEMBERS, MEMBERSHIP, 'update'))).toBe(false);
		expect(allowedBy(scope, spaceWrite(META, MEMBERSHIP, 'delete'))).toBe(false);
	});

	it('lets a type wildcard write only the collections it names', () => {
		const update = spaceWrite(META, ACCESS, 'update');
		expect(allowedBy(`space:*?collection=${ACCESS}`, update)).toBe(true);
		expect(allowedBy('space:*', update)).toBe(false);
	});

	it('governs the space itself by manage alone', () => {
		const manage = 'space:*?manage=create&manage=delete';
		expect(allowedBy(manage, { spaceType: META, skey: 'self', manage: 'create' })).toBe(true);
		expect(allowedBy(manage, { spaceType: META, skey: 'self', manage: 'update' })).toBe(false);
	});

	it.each([
		[`authority=${GROUP}`, true],
		['authority=*', true],
		['authority=did:plc:other', false],
		['skey=self', true],
		['skey=other', false]
	])('matches the group by self, its DID or * and no other, and the space key: %s', (query, ok) => {
		expect(allowedBy(`space:${MEMBERS}?${query}`, create)).toBe(ok);
	});
});

describe('spacePermissions', () => {
	it('expands a permission set from its lexicon', () => {
		const set = 'include:group.opensocial.manageMembers';
		for (const action of ['create', 'update', 'delete'] as const) {
			expect(allowedBy(set, spaceWrite(MEMBERS, MEMBERSHIP, action))).toBe(true);
		}
		expect(allowedBy(set, spaceWrite(MEMBERS, 'group.opensocial.role', 'update'))).toBe(false);
	});

	it('expands configure to the profile in meta and the authz config in members', () => {
		const set = 'include:group.opensocial.configure';
		expect(allowedBy(set, spaceWrite(META, 'group.opensocial.profile', 'update'))).toBe(true);
		expect(allowedBy(set, spaceWrite(MEMBERS, 'group.opensocial.permissions', 'update'))).toBe(
			true
		);
		expect(allowedBy(set, spaceWrite(META, ACCESS, 'update'))).toBe(false);
	});

	it('grants nothing for an unknown set, an rpc scope, or a non-string', () => {
		expect(spacePermissions(['include:com.example.nothing', 'rpc:a.b.c?aud=*', 7])).toEqual([]);
	});
});

describe('membership changes', () => {
	it('is a create, an update or a delete by what the member holds before and after', () => {
		expect(membershipAction({ from: [], to: ['member'] })).toBe('create');
		expect(membershipAction({ from: ['member'], to: ['admin'] })).toBe('update');
		expect(membershipAction({ from: ['member'], to: [] })).toBe('delete');
	});
});

describe('writeGrants', () => {
	const permissions = [
		{ role: 'admin', scopes: ['include:group.opensocial.manageMembers'], assignable: ['member'] },
		{ role: 'helper', scopes: [`space:${MEMBERS}?collection=${MEMBERSHIP}&action=create`] }
	];
	it('unions the grants of every role held, and nothing else', () => {
		const grants = writeGrants({ roles: ['admin', 'helper'], permissions });
		expect([...grants.assignable]).toEqual(['member']);
		expect(writeGrants({ roles: ['member'], permissions })).toEqual({
			...NO_GRANTS,
			roles: ['member']
		});
	});

	it("keeps an access record's grants to its own space", () => {
		const grants = writeGrants({
			roles: ['member'],
			permissions: [],
			access: { [META]: [{ role: 'member', scopes: ['space:*?collection=x.y.z'] }] }
		});
		expect(allowsWrite(grants, GROUP, spaceWrite(META, 'x.y.z', 'create'))).toBe(true);
		expect(allowsWrite(grants, GROUP, spaceWrite(MEMBERS, 'x.y.z', 'create'))).toBe(false);
	});

	it('lets the group itself write anything, with no roles', () => {
		expect(allowsWrite(GROUP_ITSELF, GROUP, spaceWrite(META, 'x.y.z', 'delete'))).toBe(true);
		expect(allowsWrite(GROUP_ITSELF, GROUP, spaceWrite(MEMBERS, MEMBERSHIP, 'delete'))).toBe(true);
	});
});

describe('withAccess', () => {
	it("adds a space's access grants for the roles held, and only in that space", () => {
		const grants = withAccess(writeGrants({ roles: ['member'], permissions: [] }), META, [
			{ role: 'member', scopes: ['space:*?collection=x.y.z'] },
			{ role: 'admin', scopes: ['space:*?collection=a.b.c'] }
		]);
		expect(allowsWrite(grants, GROUP, spaceWrite(META, 'x.y.z', 'create'))).toBe(true);
		expect(allowsWrite(grants, GROUP, spaceWrite(META, 'a.b.c', 'create'))).toBe(false);
		expect(allowsWrite(grants, GROUP, spaceWrite(MEMBERS, 'x.y.z', 'create'))).toBe(false);
	});
});

describe('repo scopes', () => {
	const EVENT = 'community.lexicon.calendar.event';

	it('read a collection, with every write action when they name none', () => {
		expect(parseRepoScope(`repo:${EVENT}`)).toEqual({
			collections: [EVENT],
			actions: ['create', 'update', 'delete']
		});
		expect(parseRepoScope(`repo?collection=${EVENT}&action=create`)?.actions).toEqual(['create']);
		expect(parseRepoScope(`space:${META}`)).toBeNull();
	});

	it('let a role write the collections they name, or any with *', () => {
		const grants = (scopes: string[]) =>
			writeGrants({ roles: ['admin'], permissions: [{ role: 'admin', scopes }] });
		expect(allowsRepoWrite(grants(['repo:*']), EVENT, 'delete')).toBe(true);
		expect(allowsRepoWrite(grants([`repo:${EVENT}?action=create`]), EVENT, 'create')).toBe(true);
		expect(allowsRepoWrite(grants([`repo:${EVENT}?action=create`]), EVENT, 'update')).toBe(false);
		expect(allowsRepoWrite(grants(['repo:a.b.c']), EVENT, 'create')).toBe(false);
	});
});

import { describe, it, expect } from 'vitest';
import {
	GROUP_ITSELF,
	NO_GRANTS,
	allowsWrite,
	membershipAction,
	parseSpaceScope,
	permits,
	spacePermissions,
	withAccess,
	writeGrants,
	type SpaceWrite
} from './scopes';

const GROUP = 'did:plc:group';
const MEMBERS = 'group.opensocial.members';
const META = 'group.opensocial.meta';
const MEMBERSHIP = 'group.opensocial.membership';

const recordWrite = (
	spaceType: string,
	collection: string,
	action: 'create' | 'update' | 'delete'
): SpaceWrite => ({ spaceType, skey: 'self', collection, action });

const allowedBy = (scopes: string[], write: SpaceWrite) =>
	spacePermissions(scopes).some((p) => permits(p, GROUP, write));

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
	it('lets a bare scope write the collections its space type declares', () => {
		expect(allowedBy([`space:${MEMBERS}`], recordWrite(MEMBERS, MEMBERSHIP, 'create'))).toBe(true);
		expect(allowedBy([`space:${MEMBERS}`], recordWrite(MEMBERS, 'x.y.z', 'create'))).toBe(false);
	});

	it('gives a read scope no write', () => {
		const read = [`space:${MEMBERS}?action=read`];
		expect(allowedBy(read, recordWrite(MEMBERS, MEMBERSHIP, 'create'))).toBe(false);
	});

	it('holds a write to its action and collection', () => {
		const scope = [`space:${MEMBERS}?collection=${MEMBERSHIP}&action=delete`];
		expect(allowedBy(scope, recordWrite(MEMBERS, MEMBERSHIP, 'delete'))).toBe(true);
		expect(allowedBy(scope, recordWrite(MEMBERS, MEMBERSHIP, 'update'))).toBe(false);
		expect(allowedBy(scope, recordWrite(META, MEMBERSHIP, 'delete'))).toBe(false);
	});

	it('lets a type wildcard write only the collections it names', () => {
		const access = ['space:*?collection=group.opensocial.access'];
		expect(allowedBy(access, recordWrite(META, 'group.opensocial.access', 'update'))).toBe(true);
		expect(allowedBy(['space:*'], recordWrite(META, 'group.opensocial.access', 'update'))).toBe(
			false
		);
	});

	it('governs the space itself by manage alone', () => {
		const manage = ['space:*?manage=create&manage=delete'];
		expect(allowedBy(manage, { spaceType: META, skey: 'self', manage: 'create' })).toBe(true);
		expect(allowedBy(manage, { spaceType: META, skey: 'self', manage: 'update' })).toBe(false);
	});

	it('matches the group by self, by its DID, or by *, and no other authority', () => {
		const write = recordWrite(MEMBERS, MEMBERSHIP, 'create');
		expect(allowedBy([`space:${MEMBERS}?authority=${GROUP}`], write)).toBe(true);
		expect(allowedBy([`space:${MEMBERS}?authority=*`], write)).toBe(true);
		expect(allowedBy([`space:${MEMBERS}?authority=did:plc:other`], write)).toBe(false);
	});

	it('matches the space key', () => {
		const write = recordWrite(MEMBERS, MEMBERSHIP, 'create');
		expect(allowedBy([`space:${MEMBERS}?skey=self`], write)).toBe(true);
		expect(allowedBy([`space:${MEMBERS}?skey=other`], write)).toBe(false);
	});
});

describe('spacePermissions', () => {
	it('expands a permission set from its lexicon', () => {
		const set = ['include:group.opensocial.manageMembers'];
		for (const action of ['create', 'update', 'delete'] as const) {
			expect(allowedBy(set, recordWrite(MEMBERS, MEMBERSHIP, action))).toBe(true);
		}
		expect(allowedBy(set, recordWrite(MEMBERS, 'group.opensocial.role', 'update'))).toBe(false);
	});

	it('expands configure to the profile in meta and the authz config in members', () => {
		const set = ['include:group.opensocial.configure'];
		expect(allowedBy(set, recordWrite(META, 'group.opensocial.profile', 'update'))).toBe(true);
		expect(allowedBy(set, recordWrite(MEMBERS, 'group.opensocial.permissions', 'update'))).toBe(
			true
		);
		expect(allowedBy(set, recordWrite(META, 'group.opensocial.access', 'update'))).toBe(false);
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
		expect(allowsWrite(grants, GROUP, recordWrite(META, 'x.y.z', 'create'))).toBe(true);
		expect(allowsWrite(grants, GROUP, recordWrite(MEMBERS, 'x.y.z', 'create'))).toBe(false);
	});

	it('lets the group itself write anything, with no roles', () => {
		expect(allowsWrite(GROUP_ITSELF, GROUP, recordWrite(META, 'x.y.z', 'delete'))).toBe(true);
		expect(allowsWrite(GROUP_ITSELF, GROUP, recordWrite(MEMBERS, MEMBERSHIP, 'delete'))).toBe(true);
	});
});

describe('withAccess', () => {
	it("adds a space's access grants for the roles held, and only in that space", () => {
		const grants = withAccess(writeGrants({ roles: ['member'], permissions: [] }), META, [
			{ role: 'member', scopes: ['space:*?collection=x.y.z'] },
			{ role: 'admin', scopes: ['space:*?collection=a.b.c'] }
		]);
		expect(allowsWrite(grants, GROUP, recordWrite(META, 'x.y.z', 'create'))).toBe(true);
		expect(allowsWrite(grants, GROUP, recordWrite(META, 'a.b.c', 'create'))).toBe(false);
		expect(allowsWrite(grants, GROUP, recordWrite(MEMBERS, 'x.y.z', 'create'))).toBe(false);
	});
});

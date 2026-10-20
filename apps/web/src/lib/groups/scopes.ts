// What a group's scopes let a member write as the group. The group host checks every
// write as the group against the scopes the writer's roles hold (opensocial.group
// `proposal.md:96-100`). atmo asks the same question for a write to its own rows,
// and for which controls a page shows. (Spec: FR-213.)
//
// A scope is a `space:` scope in the grammar of atproto proposal 0016 ("OAuth
// scopes"), or `include:` of a permission set, expanded from the copy of that set's
// lexicon in lexicons/reference. Every write atmo checks lands in one of the
// group's own spaces, so `authority=self` names the group. Any other scope, `rpc:`
// among them, permits no write here.
import configure from '../../../lexicons/reference/group/opensocial/configure.json';
import invites from '../../../lexicons/reference/group/opensocial/invites.json';
import manageMembers from '../../../lexicons/reference/group/opensocial/manageMembers.json';
import manageSpaces from '../../../lexicons/reference/group/opensocial/manageSpaces.json';
import members from '../../../lexicons/reference/group/opensocial/members.json';
import meta from '../../../lexicons/reference/group/opensocial/meta.json';
import moderate from '../../../lexicons/reference/group/opensocial/moderate.json';
import participate from '../../../lexicons/reference/group/opensocial/participate.json';

export type RecordAction = 'read_self' | 'read' | 'create' | 'update' | 'delete';
export type ManageAction = 'create' | 'update' | 'delete';
export type WriteAction = Exclude<RecordAction, 'read_self' | 'read'>;

const RECORD_ACTIONS: readonly RecordAction[] = ['read_self', 'read', 'create', 'update', 'delete'];
const MANAGE_ACTIONS: readonly ManageAction[] = ['create', 'update', 'delete'];

/** What a scope that names no `action` grants. */
const ALL_ACTIONS: readonly RecordAction[] = ['read', 'create', 'update', 'delete'];

/** One space permission: a `space:` scope, or one entry of a permission set. */
export interface SpacePermission {
	/** A space type, or `*`. */
	spaceType: string;
	/** `self`, a DID, or `*`. */
	authority: string;
	/** A space key, or `*`. */
	skey: string;
	/** Null means the collections the space type declares. */
	collections: readonly string[] | null;
	actions: readonly RecordAction[];
	manage: readonly ManageAction[];
}

/** A write as the group into one of its own spaces: a record, or the space itself. */
export type SpaceWrite =
	| { spaceType: string; skey: string; collection: string; action: WriteAction }
	| { spaceType: string; skey: string; manage: ManageAction };

/** A lexicon document, as far as this file reads one. */
interface LexiconDoc {
	id: string;
	defs: { main: { type: string; permissions?: unknown[]; collections?: unknown[] } };
}

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** The fields both forms share, as either form spells them. A field left out takes
 *  0016's default. A value outside the grammar is dropped, so a misspelled action
 *  grants less, never more. */
function toPermission(fields: {
	spaceType: string;
	authority?: string;
	skey?: string;
	collection?: string[];
	action?: string[];
	manage?: string[];
}): SpacePermission {
	return {
		spaceType: fields.spaceType,
		authority: fields.authority || 'self',
		skey: fields.skey || '*',
		collections: fields.collection ?? null,
		actions: fields.action ? RECORD_ACTIONS.filter((a) => fields.action!.includes(a)) : ALL_ACTIONS,
		manage: MANAGE_ACTIONS.filter((m) => (fields.manage ?? []).includes(m))
	};
}

/** A `space:` scope string, or null when it is not one. */
export function parseSpaceScope(scope: string): SpacePermission | null {
	if (!scope.startsWith('space:')) return null;
	const rest = scope.slice('space:'.length);
	const query = rest.indexOf('?');
	const spaceType = query < 0 ? rest : rest.slice(0, query);
	if (!spaceType) return null;
	const params = new URLSearchParams(query < 0 ? '' : rest.slice(query + 1));
	return toPermission({
		spaceType,
		authority: params.get('authority') ?? undefined,
		skey: params.get('skey') ?? undefined,
		collection: params.has('collection') ? params.getAll('collection') : undefined,
		action: params.has('action') ? params.getAll('action') : undefined,
		manage: params.getAll('manage')
	});
}

/** A permission set's space permissions. Its `rpc` entries permit no write. */
function setPermissions(doc: LexiconDoc): SpacePermission[] {
	const found: SpacePermission[] = [];
	for (const entry of doc.defs.main.permissions ?? []) {
		if (!entry || typeof entry !== 'object') continue;
		const p = entry as Record<string, unknown>;
		if (p.resource !== 'space' || typeof p.spaceType !== 'string') continue;
		found.push(
			toPermission({
				spaceType: p.spaceType,
				authority: typeof p.authority === 'string' ? p.authority : undefined,
				skey: typeof p.skey === 'string' ? p.skey : undefined,
				collection: Array.isArray(p.collection) ? strings(p.collection) : undefined,
				action: Array.isArray(p.action) ? strings(p.action) : undefined,
				manage: strings(p.manage)
			})
		);
	}
	return found;
}

const docs = (list: unknown[]) => list as LexiconDoc[];

/** The permission sets an `include:` can name, by id. */
const PERMISSION_SETS: Readonly<Record<string, readonly SpacePermission[]>> = Object.fromEntries(
	docs([configure, manageMembers, manageSpaces, moderate, participate]).map((doc) => [
		doc.id,
		setPermissions(doc)
	])
);

/** The collections each space type declares, the default for a scope that names
 *  none. A type with no declaration here, `*` included, declares none. */
const DECLARED_COLLECTIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
	docs([members, meta, invites]).map((doc) => [doc.id, strings(doc.defs.main.collections)])
);

/** Every space permission `scopes` grants. An `include:` of a set not copied here,
 *  and anything that is not a scope, grants nothing. */
export function spacePermissions(scopes: Iterable<unknown>): SpacePermission[] {
	const found: SpacePermission[] = [];
	for (const scope of scopes) {
		if (typeof scope !== 'string') continue;
		if (scope.startsWith('include:')) {
			// A set's own parameters (`aud`) scope its `rpc` entries only.
			const id = scope.slice('include:'.length).split('?')[0];
			found.push(...(PERMISSION_SETS[id] ?? []));
			continue;
		}
		const permission = parseSpaceScope(scope);
		if (permission) found.push(permission);
	}
	return found;
}

/** Whether `permission` covers `write`, a write into a space of `groupDid`'s. A
 *  record write needs its action and its collection; a space write needs its
 *  `manage` verb and ignores collections, as in 0016's "Matching". */
export function permits(permission: SpacePermission, groupDid: string, write: SpaceWrite): boolean {
	if (permission.spaceType !== '*' && permission.spaceType !== write.spaceType) return false;
	const { authority } = permission;
	if (authority !== '*' && authority !== 'self' && authority !== groupDid) return false;
	if (permission.skey !== '*' && permission.skey !== write.skey) return false;
	if ('manage' in write) return permission.manage.includes(write.manage);
	if (!permission.actions.includes(write.action)) return false;
	const collections = permission.collections ?? DECLARED_COLLECTIONS[permission.spaceType] ?? [];
	return collections.includes('*') || collections.includes(write.collection);
}

/** One role's grant, as `permissions` and `access` records hold them. */
export interface RoleGrant {
	role: string;
	scopes: readonly unknown[];
	/** `permissions` only. */
	assignable?: readonly unknown[];
}

/** What one member may write as the group: the union over their roles, since
 *  there are no deny rules (`proposal.md:40`). */
export interface WriteGrants {
	/** The group DID itself, which passes every check (`proposal.md:44`). */
	group: boolean;
	/** The role ids the member holds, for grants read later (`withAccess`). */
	roles: readonly string[];
	/** From `permissions`, good in every space. */
	anywhere: readonly SpacePermission[];
	/** From each space's `access`, good in that space only, by space type. */
	inSpace: Readonly<Record<string, readonly SpacePermission[]>>;
	/** The roles the member may grant, revoke, and eject the holders of. */
	assignable: ReadonlySet<string>;
}

export const NO_GRANTS: WriteGrants = {
	group: false,
	roles: [],
	anywhere: [],
	inSpace: {},
	assignable: new Set()
};

export const GROUP_ITSELF: WriteGrants = { ...NO_GRANTS, group: true };

/** A member's grants, from the roles their `membership` names. A grant for a role
 *  they do not hold adds nothing, and a role no grant names adds nothing. */
export function writeGrants(input: {
	roles: Iterable<string>;
	permissions: readonly RoleGrant[];
	/** Each space's `access` grants, by space type. */
	access?: Readonly<Record<string, readonly RoleGrant[]>>;
}): WriteGrants {
	const held = new Set(input.roles);
	const mine = (grants: readonly RoleGrant[]) => grants.filter((grant) => held.has(grant.role));
	const assignable = new Set<string>();
	for (const grant of mine(input.permissions)) {
		for (const role of strings(grant.assignable)) assignable.add(role);
	}
	return {
		group: false,
		roles: [...held],
		anywhere: spacePermissions(mine(input.permissions).flatMap((grant) => grant.scopes)),
		inSpace: Object.fromEntries(
			Object.entries(input.access ?? {}).map(([spaceType, grants]) => [
				spaceType,
				spacePermissions(mine(grants).flatMap((grant) => grant.scopes))
			])
		),
		assignable
	};
}

/** `grants` with one more space's `access` grants added, for a space whose
 *  record was not read with the rest. */
export function withAccess(
	grants: WriteGrants,
	spaceType: string,
	access: readonly RoleGrant[]
): WriteGrants {
	if (grants.group) return grants;
	const held = new Set(grants.roles);
	const added = spacePermissions(
		access.filter((grant) => held.has(grant.role)).flatMap((grant) => grant.scopes)
	);
	return {
		...grants,
		inSpace: { ...grants.inSpace, [spaceType]: [...(grants.inSpace[spaceType] ?? []), ...added] }
	};
}

/** Whether `grants` cover `write`, into a space of `groupDid`'s. */
export function allowsWrite(grants: WriteGrants, groupDid: string, write: SpaceWrite): boolean {
	if (grants.group) return true;
	const inSpace = grants.inSpace[write.spaceType] ?? [];
	return [...grants.anywhere, ...inSpace].some((p) => permits(p, groupDid, write));
}

/** A `membership` write, by the roles the member holds before and after it. */
export interface MembershipChange {
	/** Empty for a member with no record yet. */
	from: readonly string[];
	/** Empty for an ejection. */
	to: readonly string[];
}

/** The roles a membership write must be allowed to assign: every role it adds or
 *  removes, so an ejection touches every role the member held. */
export function rolesTouched(change: MembershipChange): string[] {
	const from = new Set(change.from);
	const to = new Set(change.to);
	return [...new Set([...change.from, ...change.to])].filter((r) => from.has(r) !== to.has(r));
}

/** The record action a membership change is: a create for a member with no record,
 *  a delete for an ejection, and an update otherwise. */
export function membershipAction(change: MembershipChange): WriteAction {
	if (change.to.length === 0) return 'delete';
	return change.from.length === 0 ? 'create' : 'update';
}

/** Whether `grants` may make `change` to a member's `membership` in the members space
 *  `membersSpace` (its type and key): the scope for the write, and every role it
 *  touches in the union of the writer's `assignable` (`proposal.md:46`). Both must
 *  hold, so an `assignable` with no scope to write memberships allows nothing. */
export function allowsMembershipWrite(
	grants: WriteGrants,
	groupDid: string,
	membersSpace: { spaceType: string; skey: string; collection: string },
	change: MembershipChange
): boolean {
	if (grants.group) return true;
	const write = { ...membersSpace, action: membershipAction(change) };
	return (
		allowsWrite(grants, groupDid, write) &&
		rolesTouched(change).every((role) => grants.assignable.has(role))
	);
}

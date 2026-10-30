// What a group's scopes let a member write, for atmo's own rows and the controls a page
// shows; the host checks every write as the group. An `include:` expands only from the
// copies of the sets in lexicons/reference.
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

const ALL_ACTIONS: readonly RecordAction[] = ['read', 'create', 'update', 'delete'];

export interface SpacePermission {
	spaceType: string;
	authority: string;
	skey: string;
	/** Null means the collections the space type declares. */
	collections: readonly string[] | null;
	actions: readonly RecordAction[];
	manage: readonly ManageAction[];
}

export type SpaceWrite =
	| { spaceType: string; skey: string; collection: string; action: WriteAction }
	| { spaceType: string; skey: string; manage: ManageAction };

interface LexiconDoc {
	id: string;
	defs: { main: { type: string; permissions?: unknown[]; collections?: unknown[] } };
}

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

// A value outside the grammar is dropped, so a misspelled action grants less, never more.
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

const PERMISSION_SETS: Readonly<Record<string, readonly SpacePermission[]>> = Object.fromEntries(
	docs([configure, manageMembers, manageSpaces, moderate, participate]).map((doc) => [
		doc.id,
		setPermissions(doc)
	])
);

// The default for a scope that names no collection.
const DECLARED_COLLECTIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
	docs([members, meta, invites]).map((doc) => [doc.id, strings(doc.defs.main.collections)])
);

export function spacePermissions(scopes: Iterable<unknown>): SpacePermission[] {
	const found: SpacePermission[] = [];
	for (const scope of scopes) {
		if (typeof scope !== 'string') continue;
		if (scope.startsWith('include:')) {
			const id = scope.slice('include:'.length).split('?')[0];
			found.push(...(PERMISSION_SETS[id] ?? []));
			continue;
		}
		const permission = parseSpaceScope(scope);
		if (permission) found.push(permission);
	}
	return found;
}

/** A record write needs its action and its collection; a space write needs its
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

export interface RepoPermission {
	collections: readonly string[];
	actions: readonly WriteAction[];
}

/** `repo:<collection>` or `repo?collection=`, with every write action when it names none. */
export function parseRepoScope(scope: string): RepoPermission | null {
	const match = /^repo(?::([^?]*))?(?:\?(.*))?$/.exec(scope);
	if (!match) return null;
	const params = new URLSearchParams(match[2] ?? '');
	const collections = match[1] ? [match[1]] : params.getAll('collection');
	if (collections.length === 0) return null;
	const named = params.getAll('action');
	const actions = named.length
		? (['create', 'update', 'delete'] as const).filter((a) => named.includes(a))
		: (['create', 'update', 'delete'] as const);
	return { collections, actions };
}

export interface RoleGrant {
	role: string;
	scopes: readonly unknown[];
	assignable?: readonly unknown[];
}

/** The union over a member's roles, since there are no deny rules. */
export interface WriteGrants {
	group: boolean;
	roles: readonly string[];
	/** From `permissions`, good in every space. */
	anywhere: readonly SpacePermission[];
	/** From each space's `access`, by space type. */
	inSpace: Readonly<Record<string, readonly SpacePermission[]>>;
	repo: readonly RepoPermission[];
	assignable: ReadonlySet<string>;
}

export const NO_GRANTS: WriteGrants = {
	group: false,
	roles: [],
	anywhere: [],
	inSpace: {},
	repo: [],
	assignable: new Set()
};

export const GROUP_ITSELF: WriteGrants = { ...NO_GRANTS, group: true };

export function writeGrants(input: {
	roles: Iterable<string>;
	permissions: readonly RoleGrant[];
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
		repo: mine(input.permissions)
			.flatMap((grant) => grant.scopes)
			.flatMap((scope) => (typeof scope === 'string' ? (parseRepoScope(scope) ?? []) : [])),
		inSpace: Object.fromEntries(
			Object.entries(input.access ?? {}).map(([spaceType, grants]) => [
				spaceType,
				spacePermissions(mine(grants).flatMap((grant) => grant.scopes))
			])
		),
		assignable
	};
}

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

export function allowsRepoWrite(
	grants: WriteGrants,
	collection: string,
	action: WriteAction
): boolean {
	if (grants.group) return true;
	return grants.repo.some(
		(p) =>
			(p.collections.includes('*') || p.collections.includes(collection)) &&
			p.actions.includes(action)
	);
}

export function allowsWrite(grants: WriteGrants, groupDid: string, write: SpaceWrite): boolean {
	if (grants.group) return true;
	const inSpace = grants.inSpace[write.spaceType] ?? [];
	return [...grants.anywhere, ...inSpace].some((p) => permits(p, groupDid, write));
}

/** Roles held before and after; `from` is empty for a new member, `to` for an ejection. */
export interface MembershipChange {
	from: readonly string[];
	to: readonly string[];
}

export function membershipAction(change: MembershipChange): WriteAction {
	if (change.to.length === 0) return 'delete';
	return change.from.length === 0 ? 'create' : 'update';
}

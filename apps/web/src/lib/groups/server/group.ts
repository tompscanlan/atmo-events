// What this site knows of a group. There is no table of groups: a group is an account at the group
// host, findable by its declaration in the index, and described by its meta space, which only
// someone who linked it reads here. A copy of its profile is cached for visitors, in a table of
// its own.
import { env } from 'cloudflare:workers';
import type { ActorIdentifier } from '@atcute/lexicons';
import type { ResourceUri } from '@atcute/lexicons/syntax';
import { createActorResolver } from '@svelte-atproto/oauth/network';
import { fetchOtherServer, timeLimitedNetwork } from '#lib/spaces/server/other-servers.js';
import { didSpaceHosts, type SpaceHosts } from '#lib/spaces/server/space-credential.js';
import { credentialSpaceReader } from '#lib/spaces/server/space-read.js';
import { ensureInit, getServerClient } from '#lib/contrail/index.js';
import {
	declarationUri,
	GROUP_ABOUT_COLLECTION,
	GROUP_ABOUT_RKEY,
	GROUP_CONFIG_COLLECTION,
	GROUP_CONFIG_RKEY,
	GROUP_DECLARATION_COLLECTION,
	GROUP_DECLARATION_RKEY,
	metaSpaceUri,
	SPACE_POLICY_COLLECTION,
	SPACE_POLICY_RKEY,
	type GroupJoinPolicy
} from '../ids';
import { groupJoinPolicy, groupWebsite } from '../fields';
import { groupHostUrl } from './enabled';
import {
	cachedProfiles,
	cacheProfile,
	DECLARED_PAGE,
	ensureGroupSchema,
	groupLabels,
	groupServers,
	SERVERS_SHOWN,
	upcomingGroups,
	type GroupHome,
	type GroupLabel,
	type GroupServer,
	type UpcomingPage
} from './declared';
import { isRecordNotFound, xrpc, type XrpcHandle } from './xrpc';

export interface ResolvedGroup {
	did: string;
	/** Null when the two-way check fails: an unverified handle is never shown. */
	handle: string | null;
	pds: string;
}

let resolver: ReturnType<typeof createActorResolver> | undefined;

export async function resolveGroup(actor: string): Promise<ResolvedGroup | null> {
	resolver ??= createActorResolver({ network: timeLimitedNetwork() });
	try {
		const { did, handle, pds } = await resolver.resolve(actor as ActorIdentifier);
		return { did, handle: handle === 'handle.invalid' ? null : handle, pds };
	} catch {
		return null;
	}
}

export function groupHostOrigin(): string | null {
	return groupHostUrl()?.origin ?? null;
}

/** This site changes only groups whose PDS is its own group host. */
export function atGroupHost(group: Pick<ResolvedGroup, 'pds'>): boolean {
	const origin = groupHostOrigin();
	if (origin === null) return false;
	try {
		return new URL(group.pds).origin === origin;
	} catch {
		return false;
	}
}

/** A group's spaces as this site reads them through a link: their authority is the configured
 *  group host, whatever the group's DID document says now, so a document changed since the link
 *  cannot send the link's reads elsewhere. Only the key that checks the host's answers comes from
 *  the document. */
export const groupHostSpaces: SpaceHosts = {
	repoHost: async () => {
		const origin = groupHostOrigin();
		if (!origin) throw new Error('no group host is set');
		return origin;
	},
	kemKey: (did, fresh) => didSpaceHosts.kemKey(did, fresh)
};

/** The index alone answers, so a declaration moderation hid stays hidden. Throws when the
 *  index cannot say, so "could not ask" never reads as "not declared". */
export async function isDeclared(groupDid: string): Promise<boolean> {
	const res = await getServerClient(env.DB).get('rsvp.atmo.declaration.getRecord', {
		params: { uri: declarationUri(groupDid) as ResourceUri }
	});
	if (res.ok) return true;
	if (res.status === 404 || res.data.error === 'RecordNotFound') return false;
	throw new Error(`the declaration index answered ${res.status} ${res.data.error ?? ''}`.trim());
}

/** The index's tables and the groups' own, made when first needed. */
async function groupsDatabase(): Promise<D1Database> {
	await ensureInit(env.DB);
	await ensureGroupSchema(env.DB);
	return env.DB;
}

// Which accounts this site's own group host holds. A DID document can name any server as its PDS,
// so an account can name this site's group host without being held there: the list asks the host
// itself, by `com.atproto.sync.listRepos`, and counts as its groups only the accounts it lists. For
// any other server nothing short of asking it would tell, and a server is whatever accounts name
// it: their groups are shown as naming that server, which is all the list can know of them.

const HELD_KEY = 'groups:held-at-host';
const HELD_TTL_SECONDS = 600;
/** Accounts read at most, by listRepos pages of 1000; groups past them are not counted as there.
 *  GROUP_HOST_ACCOUNTS_READ sets it, rounded up to a whole page. */
const HELD_ACCOUNTS = 10_000;
/** For the whole read, every page in it: a host that hangs costs the list this wait, no more. */
const HELD_TIME_LIMIT_MS = 8_000;
/** KV's shortest expiry, and the least GROUP_HOST_RETRY_SECONDS can set. */
const HELD_FAILURE_TTL_SECONDS = 60;

/** An optional count setting: a whole number above zero, or else `fallback`. */
function countSetting(value: string | undefined, fallback: number): number {
	const raw = value?.trim() ?? '';
	const n = Number(raw);
	return /^\d+$/.test(raw) && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

let heldReading: Promise<string[] | null> | null = null;
/** Counts the times the answer was forgotten here, so a read that began before is not cached. */
let heldForgotten = 0;

/** The DIDs this site's group host says it holds, at most HELD_ACCOUNTS of them, cached for
 *  ten minutes. Null when there is no host or it did not answer in time: then no account counts
 *  as one of its groups. A host that did not answer is remembered for a minute, or as long as
 *  GROUP_HOST_RETRY_SECONDS says, and reads at the same time share one, so a host that is down
 *  costs one wait, not one per page. */
export async function heldAtGroupHost(): Promise<string[] | null> {
	const origin = groupHostOrigin();
	if (!origin) return null;
	const cached = await env.OAUTH_SESSIONS?.get<{ origin: string; dids?: string[] }>(
		HELD_KEY,
		'json'
	).catch(() => null);
	if (cached?.origin === origin) return cached.dids ?? null;
	heldReading ??= readHeld(origin).finally(() => {
		heldReading = null;
	});
	return heldReading;
}

/** After this site links a group, so the list counts it at once rather than once the cached
 *  answer expires. A read already under way is not cached, since it may have begun before
 *  the group was there. */
export async function forgetHeldAtGroupHost(): Promise<void> {
	heldForgotten++;
	heldReading = null;
	await env.OAUTH_SESSIONS?.delete(HELD_KEY).catch((e) => {
		console.warn('[groups] what the group host holds could not be forgotten:', e);
	});
}

async function listHeld(origin: string): Promise<string[]> {
	const dids: string[] = [];
	let cursor: string | null = null;
	const pages = Math.ceil(countSetting(env.GROUP_HOST_ACCOUNTS_READ, HELD_ACCOUNTS) / 1000);
	for (let page = 0; page < pages; page++) {
		const url = new URL('/xrpc/com.atproto.sync.listRepos', origin);
		url.searchParams.set('limit', '1000');
		if (cursor) url.searchParams.set('cursor', cursor);
		const res = await fetchOtherServer(url, { method: 'GET' });
		if (!res.ok) throw new Error(`listRepos answered ${res.status}`);
		const body = (await res.json()) as {
			repos?: { did?: unknown; active?: unknown }[];
			cursor?: unknown;
		};
		for (const repo of body.repos ?? []) {
			if (typeof repo.did === 'string' && repo.active !== false) dids.push(repo.did);
		}
		const next = typeof body.cursor === 'string' && body.cursor ? body.cursor : null;
		if (!next || next === cursor) break;
		cursor = next;
	}
	return dids;
}

async function readHeld(origin: string): Promise<string[] | null> {
	const kv = env.OAUTH_SESSIONS;
	const forgotten = heldForgotten;
	const current = () => forgotten === heldForgotten;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const late = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error('listRepos had no answer in time')),
				HELD_TIME_LIMIT_MS
			);
		});
		const dids = await Promise.race([listHeld(origin), late]);
		if (current()) {
			await kv
				?.put(HELD_KEY, JSON.stringify({ origin, dids }), { expirationTtl: HELD_TTL_SECONDS })
				.catch((e) => console.warn('[groups] what the group host holds was not cached:', e));
		}
		return dids;
	} catch (e) {
		console.warn('[groups] the group host did not say which groups it holds:', e);
		if (current()) {
			await kv
				?.put(HELD_KEY, JSON.stringify({ origin }), {
					expirationTtl: Math.max(
						HELD_FAILURE_TTL_SECONDS,
						countSetting(env.GROUP_HOST_RETRY_SECONDS, HELD_FAILURE_TTL_SECONDS)
					)
				})
				.catch(() => {});
		}
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** This site's group host and the accounts it holds, for the list: none held when it did not say. */
async function home(): Promise<GroupHome | null> {
	const origin = groupHostOrigin();
	return origin ? { origin, held: (await heldAtGroupHost()) ?? [] } : null;
}

/** A page of the groups with an event coming, soonest first: see upcomingGroups. Read from the
 *  index's tables directly, in one query. */
export async function listUpcomingGroups(cursor: string | null = null): Promise<UpcomingPage> {
	const [db, at] = await Promise.all([groupsDatabase(), home()]);
	return upcomingGroups(db, new Date().toISOString(), cursor, at);
}

/** The servers with declared groups, with how many each has and how many of those have an event
 *  coming. */
export async function listGroupServers(): Promise<GroupServer[]> {
	const [db, at] = await Promise.all([groupsDatabase(), home()]);
	const shown = countSetting(env.GROUP_SERVERS_SHOWN, SERVERS_SHOWN);
	return groupServers(db, new Date().toISOString(), shown, at);
}

/** Of `dids`, listed as `server`'s, those that server holds: all of them for any server but this
 *  site's group host, which is asked. */
export async function heldOf(server: string, dids: string[]): Promise<string[]> {
	if (server !== groupHostOrigin()) return dids;
	const held = new Set((await heldAtGroupHost()) ?? []);
	return dids.filter((did) => held.has(did));
}

export interface DeclaredGroupsPage {
	dids: string[];
	/** For the next page; null on the last. */
	cursor: string | null;
}

/** One page of declared groups, newest first, the index's own order: one server's with `server`,
 *  those a search finds with `q`, or both. No `actor`, which would backfill that repo on demand,
 *  and no `profiles`, which contrail refetches on every call for an account without a Bluesky
 *  profile, as a group is. */
export async function listDeclaredGroups({
	cursor = null,
	server = null,
	q = null
}: {
	cursor?: string | null;
	server?: string | null;
	q?: string | null;
} = {}): Promise<DeclaredGroupsPage> {
	const res = await getServerClient(env.DB).get('rsvp.atmo.declaration.listDeclared', {
		params: {
			limit: DECLARED_PAGE,
			...(cursor ? { cursor } : {}),
			...(server ? { server } : {}),
			...(q ? { q } : {})
		}
	});
	if (!res.ok) throw new Error(`the declaration index answered ${res.status}`);
	return {
		dids: res.data.records.map((record) => record.did),
		cursor: res.data.cursor || null
	};
}

/** The groups' handles and cached names, read from the database with no network call. */
export async function readGroupLabels(dids: string[]): Promise<Map<string, GroupLabel>> {
	return groupLabels(await groupsDatabase(), dids);
}

export interface GroupProfile {
	name: string;
	description: string | null;
	/** Its website, only an http(s) URL; left out when it has none, or one that is not. */
	website?: string;
}

/** The about record requires `displayName`; a record without one reads as no profile. */
export function parseGroupProfile(value: unknown): GroupProfile | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const name = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
	if (!name) return null;
	const description = typeof raw.description === 'string' ? raw.description.trim() : '';
	const website = groupWebsite(raw.website);
	return { name, description: description || null, ...(website ? { website } : {}) };
}

export interface GroupMeta {
	profile: GroupProfile | null;
	/** `publicRead` in the meta space's policy; a missing record reads as private. */
	public: boolean;
}

export interface LinkedMeta extends GroupMeta {
	/** From its config: null for one this site does not know; approval, as the host takes it, for
	 *  none. */
	joinPolicy: GroupJoinPolicy | null;
}

/** Read as the group itself, through a session someone linked, for that person's page. A group
 *  host serves a space's records only to a space credential: the session asks the host for a
 *  delegation token for the meta space, the host, as the space's authority, exchanges it for a
 *  credential, and each record comes back with a MAC. All three reads share the one credential. A
 *  session whose member may no longer read the space throws `SpaceAccessDenied`. */
export async function readLinkedMeta(
	handle: XrpcHandle,
	groupDid: string,
	hosts: SpaceHosts = groupHostSpaces
): Promise<LinkedMeta> {
	const reader = credentialSpaceReader({ handle }, hosts);
	const space = metaSpaceUri(groupDid);
	const read = (collection: string, rkey: string) =>
		reader.get({ space, repo: groupDid, collection, rkey });
	const [about, config, policy] = await Promise.all([
		read(GROUP_ABOUT_COLLECTION, GROUP_ABOUT_RKEY),
		read(GROUP_CONFIG_COLLECTION, GROUP_CONFIG_RKEY),
		read(SPACE_POLICY_COLLECTION, SPACE_POLICY_RKEY)
	]);
	const joinPolicy = config?.value.joinPolicy;
	return {
		...groupMetaOf(about?.value ?? null, policy?.value ?? null),
		joinPolicy: joinPolicy === undefined ? 'approval' : groupJoinPolicy(joinPolicy)
	};
}

/** From the meta space's about record and its published policy, either missing. */
export function groupMetaOf(
	about: Record<string, unknown> | null,
	policy: Record<string, unknown> | null
): GroupMeta {
	const publicRead = (policy?.policy as { publicRead?: unknown } | undefined)?.publicRead;
	return { profile: parseGroupProfile(about), public: publicRead === true };
}

/** Whether the group's public repo holds its declaration, which may not be indexed yet. */
export async function repoHasDeclaration(handle: XrpcHandle, groupDid: string): Promise<boolean> {
	try {
		await xrpc(handle, 'com.atproto.repo.getRecord', {
			query: {
				repo: groupDid,
				collection: GROUP_DECLARATION_COLLECTION,
				rkey: GROUP_DECLARATION_RKEY
			}
		});
		return true;
	} catch (e) {
		if (isRecordNotFound(e)) return false;
		throw e;
	}
}

/** Logged, not thrown: the write landed, and the index also learns of it from Jetstream. */
export async function notifyIndex(uri: string): Promise<void> {
	try {
		const res = await getServerClient(env.DB).post('rsvp.atmo.notifyOfUpdate', {
			input: { uris: [uri as ResourceUri] }
		});
		if (!res.ok || res.data.errors?.length) {
			console.error(`[groups] the index did not take ${uri}`);
		}
	} catch (e) {
		console.error(`[groups] could not tell the index about ${uri}:`, e);
	}
}

/** A group host writes a public group's declaration itself, when the group is made and each time
 *  the meta space's policy is set while it is public, and deletes it when the meta space turns
 *  private. The index hears of either only through a relay that carries the host. So when someone
 *  who linked the group reads its repo, `inRepo`, and the index says otherwise, the index is told
 *  to read the record again, which adds or removes it. Logged, not thrown: the page shows the same
 *  without it. */
export async function syncDeclarationIndex(groupDid: string, inRepo: boolean): Promise<void> {
	try {
		if ((await isDeclared(groupDid)) === inRepo) return;
		await notifyIndex(declarationUri(groupDid));
	} catch (e) {
		console.warn(`[groups] ${groupDid}: the index could not be asked for the declaration:`, e);
	}
}

// The cached group profile: what a visitor who cannot read the meta space is shown of a declared
// group, and what search finds it by. Written only from a read as the group, and only while it is
// public. Kept in the database, so a list reads every group's in one query.

export interface CachedGroupProfile extends GroupProfile {
	handle: string | null;
}

/** None, rather than a failed page, when the database does not answer. */
export async function readCachedProfiles(dids: string[]): Promise<Map<string, CachedGroupProfile>> {
	if (dids.length === 0) return new Map();
	try {
		return await cachedProfiles(await groupsDatabase(), dids);
	} catch (e) {
		console.warn('[groups] the cached profiles could not be read:', e);
		return new Map();
	}
}

/** A private group's cached profile is removed, so its name never reaches a visitor. Every page
 *  view by someone who reads the group lands here, so a profile the same as the cached one writes
 *  nothing. */
export async function storeCachedProfile(
	group: Pick<ResolvedGroup, 'did' | 'handle'>,
	meta: GroupMeta
): Promise<void> {
	const profile = meta.public && meta.profile ? { ...meta.profile, handle: group.handle } : null;
	await cacheProfile(await groupsDatabase(), group.did, profile);
}

// What this site knows of a group. There is no table: a group is an account at the group
// host, findable by its declaration in the index, and described by its meta space, which
// only someone who linked it reads here. A copy of its profile is cached for visitors.
import { env } from 'cloudflare:workers';
import type { ActorIdentifier } from '@atcute/lexicons';
import type { ResourceUri } from '@atcute/lexicons/syntax';
import { createActorResolver } from '@svelte-atproto/oauth/network';
import { timeLimitedNetwork } from '#lib/spaces/server/other-servers.js';
import { getServerClient } from '#lib/contrail/index.js';
import {
	declarationUri,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_DECLARATION_COLLECTION,
	GROUP_DECLARATION_RKEY,
	GROUP_PROFILE_COLLECTION,
	GROUP_PROFILE_RKEY,
	groupDeclarationRecord,
	metaSpaceUri
} from '../ids';
import { cachedHandles, crowdedServers, type CrowdedServer } from './declared';
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
	const url = env.GROUP_HOST_URL?.trim();
	return url ? new URL(url).origin : null;
}

/** This site changes only groups whose PDS is its own group host. */
export function atGroupHost(group: Pick<ResolvedGroup, 'pds'>): boolean {
	const origin = groupHostOrigin();
	return origin !== null && new URL(group.pds).origin === origin;
}

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

export interface DeclaredGroup {
	did: string;
	indexedAt: number;
}

export interface DeclaredGroupsPage {
	groups: DeclaredGroup[];
	/** For the next page; null on the last. */
	cursor: string | null;
}

const HELD_KEY = 'groups:held-at-host';
const HELD_TTL_SECONDS = 600;
/** listRepos pages read at most, 1000 accounts each; groups past them are not counted as there. */
const HELD_PAGES = 10;
/** For the whole read, every page in it: a host that hangs costs the list this wait, no more. */
const HELD_TIME_LIMIT_MS = 8_000;
/** KV's shortest expiry. */
const HELD_FAILURE_TTL_SECONDS = 60;

/** The DIDs this site's group host says it holds, from its listRepos, cached for ten minutes.
 *  A DID document can name the host without the host holding the account, so this, not the
 *  document, decides which groups are at the host. Null when there is no host or it did not
 *  answer: then no group counts as at the host, and the host is limited like any server. A host
 *  that did not answer is remembered for a minute, and readers at the same time share one read,
 *  so a host that is down costs one wait, not one per page. */
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

let heldReading: Promise<string[] | null> | null = null;

async function readHeld(origin: string): Promise<string[] | null> {
	const kv = env.OAUTH_SESSIONS;
	try {
		const signal = AbortSignal.timeout(HELD_TIME_LIMIT_MS);
		const dids: string[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < HELD_PAGES; page++) {
			const url = new URL('/xrpc/com.atproto.sync.listRepos', origin);
			url.searchParams.set('limit', '1000');
			if (cursor) url.searchParams.set('cursor', cursor);
			const res = await fetch(url, { signal });
			if (!res.ok) throw new Error(`listRepos answered ${res.status}`);
			const body = (await res.json()) as {
				repos?: { did?: unknown; active?: unknown }[];
				cursor?: unknown;
			};
			for (const repo of body.repos ?? []) {
				if (typeof repo.did === 'string' && repo.active !== false) dids.push(repo.did);
			}
			cursor = typeof body.cursor === 'string' && body.cursor ? body.cursor : null;
			if (!cursor) break;
		}
		await kv
			?.put(HELD_KEY, JSON.stringify({ origin, dids }), { expirationTtl: HELD_TTL_SECONDS })
			.catch((e) => console.warn('[groups] what the group host holds was not cached:', e));
		return dids;
	} catch (e) {
		console.warn('[groups] the group host did not say which groups it holds:', e);
		await kv
			?.put(HELD_KEY, JSON.stringify({ origin }), { expirationTtl: HELD_FAILURE_TTL_SECONDS })
			.catch(() => {});
		return null;
	}
}

/** One page, newest first, the index's own order. Only the declaration at rkey `self`
 *  counts, so an account is listed once however many records it writes, and each server gets
 *  at most 20 places, except the groups this site's group host holds; `server` lists one
 *  server's groups. No `actor`, which would backfill that repo on demand, and no `profiles`,
 *  which contrail refetches on every call for an account without a Bluesky profile, as a
 *  group is. */
export async function listDeclaredGroups(
	{ cursor = null, server = null }: { cursor?: string | null; server?: string | null } = {},
	limit = 100
): Promise<DeclaredGroupsPage> {
	const home = groupHostOrigin();
	// Another server's page needs nothing from the host.
	const held = home && (!server || server === home) ? await heldAtGroupHost() : null;
	const res = await getServerClient(env.DB).get('rsvp.atmo.declaration.listDeclared', {
		params: {
			limit: Math.min(Math.max(limit, 1), 100),
			...(cursor ? { cursor } : {}),
			...(server ? { server } : {}),
			...(home && held ? { home, held: JSON.stringify(held) } : {})
		}
	});
	if (!res.ok) throw new Error(`the declaration index answered ${res.status}`);
	return {
		groups: res.data.records.map((record) => ({
			did: record.did,
			indexedAt: Math.floor(record.time_us / 1000)
		})),
		cursor: res.data.cursor || null
	};
}

/** The servers whose other groups the list leaves out, for links to their own pages. The group
 *  host is left out only when the list could be told what it holds. */
export async function listCrowdedServers(): Promise<CrowdedServer[]> {
	const home = groupHostOrigin();
	const held = home ? await heldAtGroupHost() : null;
	return crowdedServers(env.DB, held ? home : null);
}

/** The groups' handles as the index last resolved them, for groups with no cached profile. */
export function readCachedHandles(dids: string[]): Promise<Map<string, string>> {
	return cachedHandles(env.DB, dids);
}

export interface GroupProfile {
	name: string;
	description: string | null;
}

/** The profile requires `displayName`; a record without one reads as no profile. */
export function parseGroupProfile(value: unknown): GroupProfile | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const name = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
	if (!name) return null;
	const description = typeof raw.description === 'string' ? raw.description.trim() : '';
	return { name, description: description || null };
}

export interface GroupMeta {
	profile: GroupProfile | null;
	/** The meta space's `access.public`; a missing record reads as private. */
	public: boolean;
}

async function metaRecord(
	handle: XrpcHandle,
	groupDid: string,
	collection: string,
	rkey: string
): Promise<Record<string, unknown> | null> {
	try {
		const body = await xrpc(handle, 'com.atproto.space.getRecord', {
			query: { space: metaSpaceUri(groupDid), repo: groupDid, collection, rkey }
		});
		const value = body.value;
		return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	} catch (e) {
		if (isRecordNotFound(e)) return null;
		throw e;
	}
}

/** Read as the group itself, through a session someone linked. */
export async function readGroupMeta(handle: XrpcHandle, groupDid: string): Promise<GroupMeta> {
	const [profile, access] = await Promise.all([
		metaRecord(handle, groupDid, GROUP_PROFILE_COLLECTION, GROUP_PROFILE_RKEY),
		metaRecord(handle, groupDid, GROUP_ACCESS_COLLECTION, GROUP_ACCESS_RKEY)
	]);
	return { profile: parseGroupProfile(profile), public: access?.public === true };
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

/** Only a public group may be listed: the proposal publishes it only while meta is public. */
export async function listGroup(handle: XrpcHandle, groupDid: string): Promise<void> {
	await xrpc(handle, 'com.atproto.repo.putRecord', {
		body: {
			repo: groupDid,
			collection: GROUP_DECLARATION_COLLECTION,
			rkey: GROUP_DECLARATION_RKEY,
			record: groupDeclarationRecord(groupDid)
		}
	});
	await notifyIndex(declarationUri(groupDid));
}

export async function unlistGroup(handle: XrpcHandle, groupDid: string): Promise<void> {
	await xrpc(handle, 'com.atproto.repo.deleteRecord', {
		body: {
			repo: groupDid,
			collection: GROUP_DECLARATION_COLLECTION,
			rkey: GROUP_DECLARATION_RKEY
		}
	});
	await notifyIndex(declarationUri(groupDid));
}

// The cached group profile: what a visitor who cannot read the meta space is shown of a declared
// group. Written only from a read as the group, and only while it is public.

const CACHED_PROFILE_PREFIX = 'group:profile:';

export interface CachedGroupProfile extends GroupProfile {
	handle: string | null;
}

export async function readCachedProfiles(dids: string[]): Promise<Map<string, CachedGroupProfile>> {
	const profiles = new Map<string, CachedGroupProfile>();
	const kv = env.OAUTH_SESSIONS;
	if (!kv || dids.length === 0) return profiles;
	const values = await Promise.all(
		dids.map((did) =>
			kv.get<CachedGroupProfile>(CACHED_PROFILE_PREFIX + did, 'json').catch(() => null)
		)
	);
	dids.forEach((did, i) => {
		const profile = values[i];
		if (profile) profiles.set(did, profile);
	});
	return profiles;
}

/** A private group's cached profile is removed, so its name never reaches a visitor. */
export async function storeCachedProfile(
	group: Pick<ResolvedGroup, 'did' | 'handle'>,
	meta: GroupMeta
): Promise<void> {
	const kv = env.OAUTH_SESSIONS;
	if (!kv) return;
	if (!meta.public || !meta.profile) {
		await kv.delete(CACHED_PROFILE_PREFIX + group.did);
		return;
	}
	const profile: CachedGroupProfile = { ...meta.profile, handle: group.handle };
	await kv.put(CACHED_PROFILE_PREFIX + group.did, JSON.stringify(profile));
}

// What this site knows of a group. There is no table: a group is an account at the group
// host, findable by its declaration in the index, and described by its meta space, which
// only someone who linked it reads here. A copy of its profile is cached for visitors.
import { env } from 'cloudflare:workers';
import type { ActorIdentifier } from '@atcute/lexicons';
import type { ResourceUri } from '@atcute/lexicons/syntax';
import { createActorResolver } from '@svelte-atproto/oauth/network';
import { timeLimitedNetwork } from '#lib/spaces/server/other-servers.js';
import { didSpaceHosts, type SpaceHosts } from '#lib/spaces/server/space-credential.js';
import { credentialSpaceReader } from '#lib/spaces/server/space-read.js';
import { ensureInit, getServerClient } from '#lib/contrail/index.js';
import {
	declarationUri,
	GROUP_ABOUT_COLLECTION,
	GROUP_ABOUT_RKEY,
	GROUP_DECLARATION_COLLECTION,
	GROUP_DECLARATION_RKEY,
	groupDeclarationRecord,
	metaSpaceUri,
	SPACE_POLICY_COLLECTION,
	SPACE_POLICY_RKEY
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
/** Counts the times the answer was forgotten here, so a read that began before is not cached. */
let heldForgotten = 0;

/** After this site makes a group at the host, links one or lists one, so the list counts it as at
 *  the host at once rather than after the cached answer expires. A read already under way is not
 *  cached, since it may have begun before the group was there. */
export async function forgetHeldAtGroupHost(): Promise<void> {
	heldForgotten++;
	heldReading = null;
	await env.OAUTH_SESSIONS?.delete(HELD_KEY).catch((e) => {
		console.warn('[groups] what the group host holds could not be forgotten:', e);
	});
}

async function readHeld(origin: string): Promise<string[] | null> {
	const kv = env.OAUTH_SESSIONS;
	const forgotten = heldForgotten;
	const current = () => forgotten === heldForgotten;
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
				?.put(HELD_KEY, JSON.stringify({ origin }), { expirationTtl: HELD_FAILURE_TTL_SECONDS })
				.catch(() => {});
		}
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
 *  host is left out only when the list could be told what it holds. Read from the index's tables
 *  directly, so only once contrail has made them: the declarations' table is made with the rest
 *  when the Worker first uses the index, and only while groups are on. */
export async function listCrowdedServers(): Promise<CrowdedServer[]> {
	const home = groupHostOrigin();
	const [held] = await Promise.all([home ? heldAtGroupHost() : null, ensureInit(env.DB)]);
	return crowdedServers(env.DB, held ? home : null);
}

/** The groups' handles as the index last resolved them, for groups with no cached profile. Read
 *  from its identities table directly, so only once contrail has made it. */
export async function readCachedHandles(dids: string[]): Promise<Map<string, string>> {
	await ensureInit(env.DB);
	return cachedHandles(env.DB, dids);
}

export interface GroupProfile {
	name: string;
	description: string | null;
}

/** The about record requires `displayName`; a record without one reads as no profile. */
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
	/** `publicRead` in the meta space's policy; a missing record reads as private. */
	public: boolean;
}

/** Read as the group itself, through a session someone linked. A group host serves a space's
 *  records only to a space credential: the session asks the host for a delegation token for the
 *  meta space, the host, as the space's authority, exchanges it for a credential, and each record
 *  comes back with a MAC. Both reads share the one credential. A session whose member may no
 *  longer read the space throws `SpaceAccessDenied`. */
export async function readGroupMeta(
	handle: XrpcHandle,
	groupDid: string,
	hosts: SpaceHosts = didSpaceHosts
): Promise<GroupMeta> {
	const reader = credentialSpaceReader({ handle }, hosts);
	const space = metaSpaceUri(groupDid);
	const read = (collection: string, rkey: string) =>
		reader.get({ space, repo: groupDid, collection, rkey });
	const [about, policy] = await Promise.all([
		read(GROUP_ABOUT_COLLECTION, GROUP_ABOUT_RKEY),
		read(SPACE_POLICY_COLLECTION, SPACE_POLICY_RKEY)
	]);
	return groupMetaOf(about?.value ?? null, policy?.value ?? null);
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

/** Only a public group may be listed. This site's rule, kept from the earlier proposal: the spec's
 *  declaration says nothing of the meta space being public. A group host holds to it too: it
 *  writes the declaration itself while the meta space is public, and refuses one while it is
 *  private, with InvalidRequest. Putting the declaration it wrote changes nothing. */
export async function listGroup(handle: XrpcHandle, groupDid: string): Promise<void> {
	await xrpc(handle, 'com.atproto.repo.putRecord', {
		body: {
			repo: groupDid,
			collection: GROUP_DECLARATION_COLLECTION,
			rkey: GROUP_DECLARATION_RKEY,
			record: groupDeclarationRecord()
		}
	});
	await notifyIndex(declarationUri(groupDid));
	await forgetHeldAtGroupHost();
}

/** Deletes the declaration, the group host's own included, which it writes again only the next
 *  time the meta space's policy is set while it is public. */
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

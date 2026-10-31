// What this site knows of a group. There is no table: a group is an account at the group
// host, findable by its declaration in the index, and described by its meta space, which
// only someone who linked it reads here. A small card of its name is cached for visitors.
import { env } from 'cloudflare:workers';
import type { ActorIdentifier } from '@atcute/lexicons';
import type { ResourceUri } from '@atcute/lexicons/syntax';
import { createActorResolver } from '@svelte-atproto/oauth/network';
import { atprotoNetwork } from '#lib/atproto/network.js';
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
import { isRecordNotFound, xrpc, type XrpcHandle } from './xrpc';

export interface ResolvedGroup {
	did: string;
	/** Null when the two-way check fails: an unverified handle is never shown. */
	handle: string | null;
	pds: string;
}

let resolver: ReturnType<typeof createActorResolver> | undefined;

export async function resolveGroup(actor: string): Promise<ResolvedGroup | null> {
	resolver ??= createActorResolver({ network: atprotoNetwork() });
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

/** Where someone whose own server cannot grant group permissions could make an account.
 *  Null when the site names none, or names something that is not a web address. */
export function spacesServer(): { url: string; host: string } | null {
	const value = env.SPACES_PDS_URL?.trim();
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
		return { url: url.origin, host: url.host };
	} catch {
		return null;
	}
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

/** Newest first, the index's own order. No `actor`, which would backfill that repo on
 *  demand, and no `profiles`, which contrail refetches on every call for an account
 *  without a Bluesky profile, as a group is. */
export async function listDeclaredGroups(limit = 100): Promise<DeclaredGroup[]> {
	const res = await getServerClient(env.DB).get('rsvp.atmo.declaration.listRecords', {
		params: { limit: Math.min(Math.max(limit, 1), 100) }
	});
	if (!res.ok) throw new Error(`the declaration index answered ${res.status}`);
	return res.data.records.map((record) => ({
		did: record.did,
		indexedAt: Math.floor(record.time_us / 1000)
	}));
}

export const GROUP_JOIN_POLICIES = ['open', 'approval', 'invite'] as const;
export type GroupJoinPolicy = (typeof GROUP_JOIN_POLICIES)[number];

export interface GroupProfile {
	name: string;
	description: string | null;
	/** An unknown policy reads as `invite`, the most closed. */
	joinPolicy?: GroupJoinPolicy;
}

/** The profile requires `displayName`; a record without one reads as no profile. */
export function parseGroupProfile(value: unknown): GroupProfile | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const name = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
	if (!name) return null;
	const description = typeof raw.description === 'string' ? raw.description.trim() : '';
	const policy = (GROUP_JOIN_POLICIES as readonly unknown[]).includes(raw.joinPolicy)
		? (raw.joinPolicy as GroupJoinPolicy)
		: 'invite';
	return { name, description: description || null, joinPolicy: policy };
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

// The card: what a visitor who cannot read the meta space is shown of a declared group.
// Written only from a read as the group, and only while it is public.

const CARD_PREFIX = 'group:card:';

export interface GroupCard extends GroupProfile {
	handle: string | null;
}

export async function readCards(dids: string[]): Promise<Map<string, GroupCard>> {
	const cards = new Map<string, GroupCard>();
	const kv = env.OAUTH_SESSIONS;
	if (!kv || dids.length === 0) return cards;
	const values = await Promise.all(
		dids.map((did) => kv.get<GroupCard>(CARD_PREFIX + did, 'json').catch(() => null))
	);
	dids.forEach((did, i) => {
		const card = values[i];
		if (card) cards.set(did, card);
	});
	return cards;
}

/** A private group's card is removed, so its name never reaches a visitor. */
export async function storeCard(
	group: Pick<ResolvedGroup, 'did' | 'handle'>,
	meta: GroupMeta
): Promise<void> {
	const kv = env.OAUTH_SESSIONS;
	if (!kv) return;
	if (!meta.public || !meta.profile) {
		await kv.delete(CARD_PREFIX + group.did);
		return;
	}
	const card: GroupCard = { ...meta.profile, handle: group.handle };
	await kv.put(CARD_PREFIX + group.did, JSON.stringify(card));
}

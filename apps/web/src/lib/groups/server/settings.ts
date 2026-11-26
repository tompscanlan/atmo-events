// A group's settings, written as the group through a session someone linked: its about record and
// config in its meta space, whether the meta space is public (its policy, which
// com.atproto.space.updateSpace replaces whole) and whether it is on the groups list (its
// declaration). Every read comes before the first write, and the writes go in this order, so saving
// again finishes a save that stopped partway, and a group turning private is private before its
// new name is written:
//
//   private  policy says private (the host takes the declaration down) -> config -> about
//   public   policy says public (the host puts the declaration up) -> listing as asked -> config
//            -> about
//
// When the policy's visibility is no longer the one the form showed, someone changed it since, so
// it and the listing are kept rather than changed back.
import { didSpaceHosts, type SpaceHosts } from '#lib/spaces/server/space-credential.js';
import { credentialSpaceReader } from '#lib/spaces/server/space-read.js';
import { groupDescription, groupJoinPolicy, groupName, groupWebsite } from '../fields';
import {
	declarationUri,
	GROUP_ABOUT_COLLECTION,
	GROUP_ABOUT_RKEY,
	GROUP_CONFIG_COLLECTION,
	GROUP_CONFIG_RKEY,
	GROUP_POLICY_TYPE,
	metaSpaceUri,
	SPACE_POLICY_COLLECTION,
	SPACE_POLICY_RKEY,
	type GroupJoinPolicy
} from '../ids';
import type { GroupWriter } from './context';
import {
	listGroup,
	notifyIndex,
	repoHasDeclaration,
	storeCachedProfile,
	unlistGroup,
	type ResolvedGroup
} from './group';
import { xrpc } from './xrpc';

export interface GroupSettings {
	name: string;
	description: string | null;
	website: string | null;
	joinPolicy: GroupJoinPolicy;
	public: boolean;
	/** On the groups list; only a public group may be. */
	listed: boolean;
}

/** Null for anything that is not a whole, valid set of settings. */
export function parseGroupSettings(value: Record<string, unknown>): GroupSettings | null {
	const name = groupName(value.name);
	const description = groupDescription(value.description);
	const website = groupWebsite(value.website);
	const joinPolicy = groupJoinPolicy(value.joinPolicy);
	if (!name || description === undefined || website === undefined || !joinPolicy) return null;
	if (typeof value.public !== 'boolean' || typeof value.listed !== 'boolean') return null;
	return {
		name,
		description,
		website,
		joinPolicy,
		public: value.public,
		listed: value.public && value.listed
	};
}

interface MetaRecords {
	about: Record<string, unknown> | null;
	config: Record<string, unknown> | null;
	/** The meta space's `org.atgrp.policy`, as the host publishes it. */
	policy: Record<string, unknown> | null;
	declared: boolean;
}

async function readMeta(writer: GroupWriter, hosts: SpaceHosts): Promise<MetaRecords> {
	const reader = credentialSpaceReader({ handle: writer.handle }, hosts);
	const space = metaSpaceUri(writer.did);
	const read = async (collection: string, rkey: string) =>
		(await reader.get({ space, repo: writer.did, collection, rkey }))?.value ?? null;
	const [about, config, published, declared] = await Promise.all([
		read(GROUP_ABOUT_COLLECTION, GROUP_ABOUT_RKEY),
		read(GROUP_CONFIG_COLLECTION, GROUP_CONFIG_RKEY),
		read(SPACE_POLICY_COLLECTION, SPACE_POLICY_RKEY),
		repoHasDeclaration(writer.handle, writer.did)
	]);
	const policy = published?.policy;
	return {
		about,
		config,
		policy:
			policy &&
			typeof policy === 'object' &&
			(policy as { $type?: unknown }).$type === GROUP_POLICY_TYPE
				? (policy as Record<string, unknown>)
				: null,
		declared
	};
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** What the settings form starts from. A config the host would not have written reads as its
 *  default, approval. */
export async function readGroupSettings(
	writer: GroupWriter,
	hosts: SpaceHosts = didSpaceHosts
): Promise<GroupSettings> {
	const { about, config, policy, declared } = await readMeta(writer, hosts);
	const isPublic = policy?.publicRead === true;
	return {
		name: text(about?.displayName) ?? '',
		description: text(about?.description),
		website: text(about?.website),
		joinPolicy: groupJoinPolicy(config?.joinPolicy) ?? 'approval',
		public: isPublic,
		listed: isPublic && declared
	};
}

/** `shownPublic` is the visibility the form showed. */
export async function saveGroupSettings(
	writer: GroupWriter,
	group: Pick<ResolvedGroup, 'did' | 'handle'>,
	settings: GroupSettings,
	shownPublic: boolean,
	hosts: SpaceHosts = didSpaceHosts
): Promise<void> {
	const { about, config, policy, declared } = await readMeta(writer, hosts);
	if (!policy) throw new Error(`${writer.did} publishes no policy for its meta space`);
	const current = policy.publicRead === true;
	const isPublic = shownPublic === current ? settings.public : current;
	// The form's listing went with the visibility it asked for.
	const listed = isPublic === settings.public ? settings.listed : declared;

	if (isPublic !== current) {
		// The whole policy, its grants as they are: updateSpace replaces it.
		await xrpc(writer.handle, 'com.atproto.space.updateSpace', {
			body: { space: metaSpaceUri(writer.did), policy: { ...policy, publicRead: isPublic } }
		});
	}
	if (isPublic) {
		// The host declares a group as its meta space turns public, or keeps the declaration.
		if (listed && (!declared || isPublic !== current)) await listGroup(writer.handle, writer.did);
		if (!listed && (declared || isPublic !== current)) await unlistGroup(writer.handle, writer.did);
	} else if (declared) {
		// The host took the declaration down; the index hears it now rather than from a relay.
		await notifyIndex(declarationUri(writer.did));
	}

	await putMeta(writer, GROUP_CONFIG_COLLECTION, GROUP_CONFIG_RKEY, {
		...config,
		joinPolicy: settings.joinPolicy
	});
	// The record's other fields, such as its avatar, are kept.
	const next: Record<string, unknown> = { ...about, displayName: settings.name };
	for (const [field, value] of [
		['description', settings.description],
		['website', settings.website]
	] as const) {
		if (value) next[field] = value;
		else delete next[field];
	}
	await putMeta(writer, GROUP_ABOUT_COLLECTION, GROUP_ABOUT_RKEY, next);

	await storeCachedProfile(group, {
		profile: { name: settings.name, description: settings.description },
		public: isPublic
	}).catch((e) =>
		console.warn(`[groups] ${writer.did}: the cached profile could not be stored:`, e)
	);
}

async function putMeta(
	writer: GroupWriter,
	collection: string,
	rkey: string,
	record: Record<string, unknown>
) {
	await xrpc(writer.handle, 'com.atproto.space.putRecord', {
		body: {
			repo: writer.did,
			space: metaSpaceUri(writer.did),
			collection,
			rkey,
			record: { ...record, $type: collection }
		}
	});
}

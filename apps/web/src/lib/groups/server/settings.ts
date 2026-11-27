import { didSpaceHosts, type SpaceHosts } from '#lib/spaces/server/space-credential.js';
import { credentialSpaceReader } from '#lib/spaces/server/space-read.js';
import {
	GROUP_ABOUT_COLLECTION,
	GROUP_ABOUT_RKEY,
	GROUP_CONFIG_COLLECTION,
	GROUP_CONFIG_RKEY,
	GROUP_POLICY_TYPE,
	metaSpaceUri,
	SPACE_POLICY_COLLECTION,
	SPACE_POLICY_RKEY
} from '../ids';
import type { GroupWriter } from './context';
import { repoHasDeclaration } from './group';
import { xrpc } from './xrpc';

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

/** Makes the group's meta space public, its policy otherwise as it is, so the host lists it: for a
 *  group made private so it was never listed, whose maker asked for it public. Nothing when it is
 *  public already, so running it again changes nothing. */
export async function makeMetaPublic(
	writer: GroupWriter,
	hosts: SpaceHosts = didSpaceHosts
): Promise<void> {
	const { policy } = await readMeta(writer, hosts);
	if (!policy) throw new Error(`${writer.did} publishes no policy for its meta space`);
	if (policy.publicRead === true) return;
	await xrpc(writer.handle, 'com.atproto.space.updateSpace', {
		body: { space: metaSpaceUri(writer.did), policy: { ...policy, publicRead: true } }
	});
}

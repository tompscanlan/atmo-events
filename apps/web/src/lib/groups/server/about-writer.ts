import { now as tidNow } from '@atcute/tid';
import {
	GROUP_PROFILE_COLLECTION,
	GROUP_PROFILE_RKEY,
	GROUP_RULE_COLLECTION,
	groupProfileRecord,
	groupRuleRecord,
	type GroupProfileInput,
	type GroupRuleFields
} from '../about-record';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord,
	accessSays,
	type GroupAccessFields
} from '../members-record';
import { ABOUT_SPACE_TYPE, type GroupRow, type GroupVisibility } from '../types';
import type { GroupSpaceReader } from './about-read';
import { gatedWriter, requireGroupWrite, type GroupRepoWriter, ownSpace } from './group-write';
import { VISIBILITY_WRITE, spaceWrite } from '../grants';
import type { RoleGrant } from '../scopes';
import type { CredentialStoreEnv } from './session';

const aboutSpace = (group: GroupRow) =>
	ownSpace(group, 'about', group.about_space_uri, 'its profile cannot be written');

export interface WriteGroupAboutInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string | null;
	writer?: GroupRepoWriter;
	reader?: GroupSpaceReader | null;
}

export interface ProfileWriteResult {
	uri: string;
	cid: string;
}

export async function writeGroupProfile(
	input: WriteGroupAboutInput & { profile: GroupProfileInput }
): Promise<ProfileWriteResult> {
	await requireGroupWrite(input, spaceWrite(ABOUT_SPACE_TYPE, GROUP_PROFILE_COLLECTION, 'update'));
	const record = { ...groupProfileRecord(input.profile), $type: GROUP_PROFILE_COLLECTION };

	const writer = await gatedWriter(input);
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_PROFILE_COLLECTION,
		rkey: GROUP_PROFILE_RKEY,
		record,
		intent: 'update',
		space: aboutSpace(input.group)
	});
	return { uri: result.uri, cid: result.cid };
}

/** The meta space's `access`, which is the group's visibility. Grants already in the
 *  record are kept and only `public` changes. A declared group's access must say
 *  public, so this goes before a declaration and after one is withdrawn. */
export async function writeAboutAccess(
	input: WriteGroupAboutInput & { visibility: GroupVisibility; grants?: readonly RoleGrant[] }
): Promise<{ uri: string; cid: string }> {
	await requireGroupWrite(input, VISIBILITY_WRITE);

	const isPublic = input.visibility === 'public';
	const record = {
		...(input.grants !== undefined
			? { public: isPublic, grants: input.grants.map(({ role, scopes }) => ({ role, scopes })) }
			: groupAccessRecord({
					spaceType: ABOUT_SPACE_TYPE,
					roles: ABOUT_SPACE_READER_ROLES,
					public: isPublic
				})),
		$type: GROUP_ACCESS_COLLECTION
	};

	const writer = await gatedWriter(input);
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY,
		record,
		intent: 'update',
		space: aboutSpace(input.group)
	});
	return { uri: result.uri, cid: result.cid };
}

/** Writes the access record only when `current` does not already say `visibility`. */
export async function alignAboutAccess(
	input: WriteGroupAboutInput & { visibility: GroupVisibility },
	current: GroupAccessFields | null
): Promise<boolean> {
	if (accessSays(current, input.visibility === 'public')) return false;
	await writeAboutAccess({ ...input, grants: current?.grants });
	return true;
}

/** The rules a new group starts with, one record each, at their place in the form. */
export async function createGroupRules(
	input: WriteGroupAboutInput & { rules: readonly GroupRuleFields[] }
): Promise<void> {
	if (input.rules.length === 0) return;
	await requireGroupWrite(input, spaceWrite(ABOUT_SPACE_TYPE, GROUP_RULE_COLLECTION, 'create'));
	const writer = await gatedWriter(input);
	for (const { text, order } of input.rules) {
		await writer({
			repo: input.group.group_did,
			collection: GROUP_RULE_COLLECTION,
			rkey: tidNow(),
			record: { ...groupRuleRecord({ text, order }), $type: GROUP_RULE_COLLECTION },
			intent: 'create',
			space: aboutSpace(input.group)
		});
	}
}

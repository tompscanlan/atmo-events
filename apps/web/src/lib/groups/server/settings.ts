// A group's settings, written as the group. Every read comes before the first write, and
// the writes go in this order, so saving again finishes a save that stopped partway:
//
//   private  withdraw the declaration -> access says private -> profile
//   public   access says public -> declare if listed, withdraw if not -> profile
//
// When the record's visibility is no longer the one the form showed, someone changed it
// since, so the record's visibility and listing are kept rather than changed back.
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_PROFILE_COLLECTION,
	GROUP_PROFILE_RKEY,
	META_SPACE_TYPE,
	metaSpaceUri
} from '../ids';
import { groupAccessRecord } from '../members-record';
import { GROUP_ROLES } from '../permissions';
import type { GroupWriter } from './context';
import {
	GROUP_JOIN_POLICIES,
	listGroup,
	repoHasDeclaration,
	storeCard,
	unlistGroup,
	type GroupJoinPolicy,
	type ResolvedGroup
} from './group';
import { isRecordNotFound, xrpc } from './xrpc';

export interface GroupSettings {
	name: string;
	description: string | null;
	joinPolicy: GroupJoinPolicy;
	public: boolean;
	listed: boolean;
}

async function readMeta(writer: GroupWriter, collection: string, rkey: string) {
	try {
		const body = await xrpc(writer.handle, 'com.atproto.space.getRecord', {
			query: { space: metaSpaceUri(writer.did), repo: writer.did, collection, rkey }
		});
		return body.value && typeof body.value === 'object'
			? (body.value as Record<string, unknown>)
			: {};
	} catch (e) {
		if (isRecordNotFound(e)) return null;
		throw e;
	}
}

async function putMeta(
	writer: GroupWriter,
	collection: string,
	rkey: string,
	record: Record<string, unknown>
) {
	await xrpc(writer.handle, 'com.atproto.space.putRecord', {
		body: {
			space: metaSpaceUri(writer.did),
			repo: writer.did,
			collection,
			rkey,
			record: { ...record, $type: collection }
		}
	});
}

/** `shownPublic` is the visibility the form showed, absent for a create. */
export async function applyGroupSettings(
	writer: GroupWriter,
	group: Pick<ResolvedGroup, 'did' | 'handle'>,
	settings: GroupSettings,
	shownPublic?: boolean
): Promise<void> {
	const [profile, access, declared] = await Promise.all([
		readMeta(writer, GROUP_PROFILE_COLLECTION, GROUP_PROFILE_RKEY),
		readMeta(writer, GROUP_ACCESS_COLLECTION, GROUP_ACCESS_RKEY),
		repoHasDeclaration(writer.handle, writer.did)
	]);
	const current = access?.public === true;
	const isPublic = shownPublic === undefined || shownPublic === current ? settings.public : current;
	// The form's listing went with the visibility it asked for.
	const listed = isPublic === settings.public ? settings.listed : declared;
	const accessRecord = {
		...(access ??
			groupAccessRecord({ spaceType: META_SPACE_TYPE, roles: GROUP_ROLES, public: false })),
		public: isPublic
	};

	if (!isPublic) {
		if (declared) await unlistGroup(writer.handle, writer.did);
		await putMeta(writer, GROUP_ACCESS_COLLECTION, GROUP_ACCESS_RKEY, accessRecord);
	} else {
		await putMeta(writer, GROUP_ACCESS_COLLECTION, GROUP_ACCESS_RKEY, accessRecord);
		if (listed) await listGroup(writer.handle, writer.did);
		else if (declared) await unlistGroup(writer.handle, writer.did);
	}

	// The record's other fields (avatar, banner, url) are kept.
	const next: Record<string, unknown> = {
		...profile,
		displayName: settings.name,
		joinPolicy: settings.joinPolicy
	};
	if (settings.description) next.description = settings.description;
	else delete next.description;
	await putMeta(writer, GROUP_PROFILE_COLLECTION, GROUP_PROFILE_RKEY, next);

	await storeCard(group, {
		profile: { name: settings.name, description: settings.description },
		public: isPublic
	}).catch((e) => console.warn(`[groups] ${writer.did}: the card could not be stored:`, e));
}

export const GROUP_NAME_MAX = 64;
export const GROUP_DESCRIPTION_MAX = 2000;

const graphemes = new Intl.Segmenter();
const length = (value: string) => [...graphemes.segment(value)].length;

/** Null for anything that is not a whole, valid set of settings, as the profile lexicon
 *  bounds them. */
export function parseGroupSettings(value: unknown): GroupSettings | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const name = typeof raw.name === 'string' ? raw.name.trim() : '';
	const description = typeof raw.description === 'string' ? raw.description.trim() : '';
	if (!name || length(name) > GROUP_NAME_MAX || length(description) > GROUP_DESCRIPTION_MAX) {
		return null;
	}
	if (!(GROUP_JOIN_POLICIES as readonly unknown[]).includes(raw.joinPolicy)) return null;
	if (typeof raw.public !== 'boolean' || typeof raw.listed !== 'boolean') return null;
	return {
		name,
		description: description || null,
		joinPolicy: raw.joinPolicy as GroupJoinPolicy,
		public: raw.public,
		listed: raw.public && raw.listed
	};
}

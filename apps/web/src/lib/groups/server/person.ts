// A group as the person signed in may see it, read with their own access: the host gives a
// credential for a group's meta space only to someone its access record lets in.
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_PROFILE_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PROFILE_RKEY,
	MEMBERS_SPACE_TYPE,
	membersSpaceUri,
	metaSpaceUri
} from '../ids';
import type { CallerSession } from './caller';
import { parseGroupProfile, type GroupMeta } from './group';
import { isSpaceAccessDenied } from './space-credential';
import { credentialSpaceReader } from './space-read';
import { xrpc } from './xrpc';

/** Throws `SpaceAccessDenied` when the host does not let the person in. */
export async function readMetaAsPerson(
	caller: CallerSession,
	groupDid: string
): Promise<GroupMeta> {
	const reader = credentialSpaceReader(caller);
	const space = metaSpaceUri(groupDid);
	const [profile, access] = await Promise.all([
		reader.get({
			space,
			repo: groupDid,
			collection: GROUP_PROFILE_COLLECTION,
			rkey: GROUP_PROFILE_RKEY
		}),
		reader.get({
			space,
			repo: groupDid,
			collection: GROUP_ACCESS_COLLECTION,
			rkey: GROUP_ACCESS_RKEY
		})
	]);
	return { profile: parseGroupProfile(profile?.value), public: access?.value.public === true };
}

const LIST_SPACES_LIMIT = 100;
const MAX_PAGES = 10;

/** The groups whose members space the person has written into, by the person's own PDS. It
 *  keeps groups that turned them away and misses groups they have written nothing in, so
 *  each still needs the host's answer (`readMetaAsPerson`). */
export async function groupSpacesOf(caller: CallerSession): Promise<string[]> {
	const dids = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const body = await xrpc(caller.handle, 'com.atproto.space.listSpaces', {
			query: {
				spaceType: MEMBERS_SPACE_TYPE,
				limit: String(LIST_SPACES_LIMIT),
				...(cursor ? { cursor } : {})
			}
		});
		const spaces = Array.isArray(body.spaces) ? body.spaces : [];
		for (const space of spaces) {
			const uri = (space as { uri?: unknown }).uri;
			const did = typeof uri === 'string' ? uri.slice('at://'.length).split('/')[0] : '';
			if (did.startsWith('did:')) dids.add(did);
		}
		const next = typeof body.cursor === 'string' ? body.cursor : undefined;
		if (!next || next === cursor || spaces.length === 0) break;
		cursor = next;
	}
	return [...dids];
}

/** A member has a `membership` record keyed by their DID, which the host lets them read. A
 *  person the host turns away is not a member; any other failure throws. */
export async function isMemberAsPerson(caller: CallerSession, groupDid: string): Promise<boolean> {
	try {
		const found = await credentialSpaceReader(caller).get({
			space: membersSpaceUri(groupDid),
			repo: groupDid,
			collection: GROUP_MEMBERSHIP_COLLECTION,
			rkey: caller.did
		});
		return found !== null;
	} catch (e) {
		if (isSpaceAccessDenied(e)) return false;
		throw e;
	}
}

const MAX_OWN_GROUPS = 50;

export interface OwnGroup {
	did: string;
	meta: GroupMeta;
}

/** "Your groups": what the person's PDS lists, each checked with the host. A group the
 *  host cannot answer for is left out, not guessed. */
export async function groupsOfPerson(caller: CallerSession): Promise<OwnGroup[]> {
	const dids = (await groupSpacesOf(caller)).slice(0, MAX_OWN_GROUPS);
	const checked = await Promise.all(
		dids.map(async (did) => {
			try {
				if (!(await isMemberAsPerson(caller, did))) return null;
				return { did, meta: await readMetaAsPerson(caller, did) };
			} catch (e) {
				console.warn(`[groups] ${did} could not be checked for ${caller.did}:`, e);
				return null;
			}
		})
	);
	return checked.filter((group): group is OwnGroup => group !== null);
}

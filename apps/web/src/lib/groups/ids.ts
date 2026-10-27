// Collections and space URIs the server code and the pages share. Values only.
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from './types';

export const GROUP_EVENT_COLLECTION = 'community.lexicon.calendar.event';

/** Every space is keyed `self`, so a group's space URIs follow from its DID alone. */
export const SPACE_SKEY = 'self';

export function spaceUri(ownerDid: string, type: string, skey: string): string {
	return `at://${ownerDid}/space/${type}/${skey}`;
}

export interface GroupSpaceUris {
	aboutSpaceUri: string;
	membersSpaceUri: string;
}

export function groupSpaceUris(groupDid: string): GroupSpaceUris {
	return {
		aboutSpaceUri: spaceUri(groupDid, ABOUT_SPACE_TYPE, SPACE_SKEY),
		membersSpaceUri: spaceUri(groupDid, MEMBERS_SPACE_TYPE, SPACE_SKEY)
	};
}

/** A space record's URI, in the form `getRecord` returns. */
export function spaceRecordUri(
	space: string,
	repo: string,
	collection: string,
	rkey: string
): string {
	return `${space}/${repo}/${collection}/${rkey}`;
}

/** Collection and rkey are the last two segments of a plain and a space record URI alike. */
export function splitRecordUri(uri: string): { collection: string; rkey: string } {
	const segments = uri.split('/');
	return {
		collection: segments[segments.length - 2] ?? '',
		rkey: segments[segments.length - 1] ?? ''
	};
}

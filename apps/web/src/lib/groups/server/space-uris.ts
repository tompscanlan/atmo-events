// A group's space URIs and the host's read-policy names: values only, no
// transport. Kept apart from ./spaces.ts, which imports the event writer for its
// permission gate, so the event writer can name the calendar space and its policy
// without the two modules importing each other.
import { ABOUT_SPACE_TYPE, CALENDAR_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';

export const POLICY_PUBLIC = 'com.atproto.simplespace.defs#publicPolicy';
export const POLICY_MEMBER_LIST = 'com.atproto.simplespace.defs#memberListPolicy';

/** Every space is keyed `self`, the atproto singleton convention. A group owns
 *  one space of each type, so its space URIs follow from the DID alone. Never key
 *  a space on a user-chosen name, which can change or collide. */
export const SPACE_SKEY = 'self';

/** The PDS builds a space URI from owner, type and skey with no lookup. So an
 *  existing space's URI can be computed, which makes provisioning idempotent. */
export function spaceUri(ownerDid: string, type: string, skey: string): string {
	return `at://${ownerDid}/space/${type}/${skey}`;
}

export interface GroupSpaceUris {
	aboutSpaceUri: string;
	membersSpaceUri: string;
	/** No column holds it: it follows from the DID, like the other two, so a
	 *  group made before the calendar space existed needs no migration.
	 *  (Spec: FR-101a.) */
	calendarSpaceUri: string;
}

/** Every space URI from the DID alone, for a cache rebuild. */
export function groupSpaceUris(groupDid: string): GroupSpaceUris {
	return {
		aboutSpaceUri: spaceUri(groupDid, ABOUT_SPACE_TYPE, SPACE_SKEY),
		membersSpaceUri: spaceUri(groupDid, MEMBERS_SPACE_TYPE, SPACE_SKEY),
		calendarSpaceUri: spaceUri(groupDid, CALENDAR_SPACE_TYPE, SPACE_SKEY)
	};
}

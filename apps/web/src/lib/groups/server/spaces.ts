// A group's three spaces, owned by the group's DID. Each space's `access`
// record is its policy, so a group needs one space per audience:
//
//   about     by visibility      profile and rules: public for a public group,
//                                its roles for a private one
//   members   its roles          roles, membership and access
//   calendar  its roles          members-only events, whatever the visibility
//
// The group's host decides every read of a space from its `access` record, for
// every app, so the group's visibility is the about space's `access.public`.
// atmo writes the other two spaces' records not public. (Spec: FR-214.) Nothing
// here sets a read policy or a member list: the host keeps neither apart from
// the records.
import { ABOUT_SPACE_TYPE, type GroupRow, type GroupVisibility } from '../types';
import type { GroupAccessFields } from '../members-record';
import { readAboutAccess, type GroupSpaceReader } from './about-read';

/** The visibility an about space's `access` record gives. Missing reads as private. */
export function visibilityFromAccess(access: GroupAccessFields | null): GroupVisibility {
	return access?.public === true ? 'public' : 'private';
}

/** A group's visibility: its about space's `access.public`. D1 does not store it.
 *  Throws when it cannot read the record, so "could not ask" never reads as
 *  either visibility. (Spec: FR-214.) */
export async function readGroupVisibility(
	reader: GroupSpaceReader,
	group: Pick<GroupRow, 'group_did' | 'about_space_uri'>
): Promise<GroupVisibility> {
	if (!group.about_space_uri) {
		throw new GroupSpaceError(
			`${group.group_did} has no about space yet, so its visibility cannot be read from its PDS`,
			ABOUT_SPACE_TYPE
		);
	}
	return visibilityFromAccess(await readAboutAccess(reader, group));
}

/** The host refused to create the space. Distinct from a record error so a
 *  half-provisioned group is not reported as a bad record. */
export class GroupSpaceError extends Error {
	constructor(
		message: string,
		readonly spaceType: string
	) {
		super(message);
		this.name = 'GroupSpaceError';
	}
}

/** A space to make at the group's host (`group.opensocial.createSpace`). */
export interface SpaceProvision {
	type: string;
	/** Always `SPACE_SKEY`. */
	skey: string;
	/** The space's `access` record, which the host makes the space with and
	 *  decides every read of it from. */
	access?: {
		public?: boolean;
		grants: { role: string; scopes: string[] }[];
	};
}

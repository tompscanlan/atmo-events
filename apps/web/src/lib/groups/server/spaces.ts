// A group's visibility is its meta space's `access.public`: the host decides every read
// of a space from that record, for every app.
import { ABOUT_SPACE_TYPE, type GroupRow, type GroupVisibility } from '../types';
import type { GroupAccessFields } from '../members-record';
import { readAboutAccess, type GroupSpaceReader } from './about-read';

/** Missing reads as private. */
export function visibilityFromAccess(access: GroupAccessFields | null): GroupVisibility {
	return access?.public === true ? 'public' : 'private';
}

/** Throws when it cannot read the record, so "could not ask" never reads as either. */
export async function readGroupVisibility(
	reader: GroupSpaceReader,
	group: Pick<GroupRow, 'group_did' | 'about_space_uri'>
): Promise<GroupVisibility> {
	if (!group.about_space_uri) {
		throw new GroupSpaceError(
			`${group.group_did} has no meta space yet, so its visibility cannot be read`,
			ABOUT_SPACE_TYPE
		);
	}
	return visibilityFromAccess(await readAboutAccess(reader, group));
}

export class GroupSpaceError extends Error {
	constructor(
		message: string,
		readonly spaceType: string
	) {
		super(message);
		this.name = 'GroupSpaceError';
	}
}

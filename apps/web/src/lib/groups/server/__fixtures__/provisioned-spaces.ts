// A group's three spaces as a create leaves them for a visibility, and a check
// that no space is ever more open than its `access` record says.
//
// The create provisions every space member-list, writes the about space's
// `access` record saying the visibility, and opens a public group's about space
// only after that (../../create-group.ts). A test that needs a public or private
// group at the fake host (./stub-pds.ts) builds it the same way, through the
// real transports and past no gate. (Spec: FR-214.)
import {
	ABOUT_SPACE_READER_ROLES,
	accessGrantsRead,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_MEMBERSHIP_COLLECTION,
	groupAccessRecord,
	parseGroupAccess
} from '../../members-record';
import { ABOUT_SPACE_TYPE, type GroupVisibility } from '../../types';
import { groupSpaceUris, POLICY_PUBLIC, type GroupSpaceUris } from '../../ids';
import { pdsWriter } from '../group-write';
import type { GroupCredential } from '../session';
import { pdsProvisioner, pdsSpaceUpdater, provisionGroupSpaces } from '../spaces';
import type { stubPds } from './stub-pds';

/** Provisions the three spaces, writes the about space's `access` saying
 *  `visibility`, and opens the about space after it when public. */
export async function provisionSpacesFor(
	cred: GroupCredential,
	groupDid: string,
	visibility: GroupVisibility
): Promise<GroupSpaceUris> {
	const uris = await provisionGroupSpaces(pdsProvisioner(cred, groupDid));
	await pdsWriter(
		cred,
		groupDid
	)({
		repo: groupDid,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY,
		record: {
			...groupAccessRecord({
				spaceType: ABOUT_SPACE_TYPE,
				roles: ABOUT_SPACE_READER_ROLES,
				public: visibility === 'public'
			}),
			$type: GROUP_ACCESS_COLLECTION
		},
		intent: 'update',
		space: uris.aboutSpaceUri
	});
	if (visibility === 'public') {
		await pdsSpaceUpdater(cred, groupDid)({ space: uris.aboutSpaceUri, readPolicy: POLICY_PUBLIC });
	}
	return uris;
}

/**
 * Every way the fake host holds a space more open than its `access` record
 * says, as sentences; empty when it holds none. For a `afterWrite` hook, so the
 * check runs between every two writes:
 *
 *   - a space whose read policy is public while its `access` does not say public
 *   - a member-list entry for a DID whose membership names no role the space's
 *     `access` grants `read`, or who has no membership at all
 *
 * A space with no `access` record grants no one, so any entry on it, or a public
 * read policy, is too open. The group's own DID owns every space and is never
 * listed, so it is not checked.
 */
export function tooOpen(pds: ReturnType<typeof stubPds>, groupDid: string): string[] {
	const uris = groupSpaceUris(groupDid);
	const roles = new Map<string, string[]>();
	for (const value of pds.records(uris.membersSpaceUri, GROUP_MEMBERSHIP_COLLECTION)) {
		const subject = typeof value.member === 'string' ? value.member : null;
		const named = Array.isArray(value.roles)
			? value.roles.filter((r): r is string => typeof r === 'string')
			: [];
		if (subject) roles.set(subject, named);
	}
	const found: string[] = [];
	for (const [kind, space] of Object.entries({
		about: uris.aboutSpaceUri,
		members: uris.membersSpaceUri,
		calendar: uris.calendarSpaceUri
	})) {
		const config = pds.spaces.get(space);
		if (!config) continue;
		const access = parseGroupAccess(pds.record(space, GROUP_ACCESS_COLLECTION, GROUP_ACCESS_RKEY));
		const policy = (config.readPolicy as { $type?: string } | undefined)?.$type;
		if (policy === POLICY_PUBLIC && access?.public !== true) {
			found.push(`the ${kind} space is public while its access record does not say public`);
		}
		for (const { did } of pds.members(space)) {
			if (did === groupDid) continue;
			if (!accessGrantsRead(access, roles.get(did) ?? [])) {
				found.push(`${did} is on the ${kind} space's list, which its roles do not read`);
			}
		}
	}
	return found;
}

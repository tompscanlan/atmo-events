// The roster writer, and the gate in front of it.
//
// The most important cases are the self-service pair. `join` and `leave` are
// the only roster writes authorized by identity rather than by a grant. If the
// identity check were dropped, they would become an unguarded admit and an
// unguarded eject: any signed-in caller, any subject, no permission needed. A
// plain member holds none of the three roster grants, which is why the branch
// exists, and why it is easy to "simplify" it into a permission check that
// happens to pass for admins.
//
// The other cases check where the records go (the members space, authored by
// the group). That a membership lands
// where the gate reads it is the roster tests' (./roster.test.ts), which run
// every act through these writers.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';

import { dropGroupMembership, putGroupMembership, writeEventPermissions } from './members-writer';

import type { GroupRow } from '../types';
import {
	recordingWriter,
	type FakeSpaceReader,
	type RecordingWriter
} from './__fixtures__/space-reader';

import { authzReader } from './__fixtures__/members-space';
import { GroupPermissionError, GroupRecordError, type GroupRepoWrite } from './group-write';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const CREATOR = 'did:plc:creator';
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const STRANGER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let writes: GroupRepoWrite[];
let writer: RecordingWriter;
/** Reads back what `writer` wrote, so the gate resolves from the same members
 *  space the test writes into. It starts as a create leaves it: the authz
 *  config, and a membership for each roster row `seedGroup` wrote. */
let reader: FakeSpaceReader;

// The writers take an env only to resolve a credential, and every case here
// injects its own transport, so it is never consulted.
const env = {};

beforeEach(async () => {
	({ harness, db, group } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: CREATOR,
		name: 'Kona',
		members: { [ADMIN]: 'admin', [MEMBER]: 'member' }
	}));

	reader = authzReader(GROUP_DID, { [CREATOR]: 'admin', [ADMIN]: 'admin', [MEMBER]: 'member' });
	writer = recordingWriter(reader);
	writes = writer.writes;
});

afterEach(() => harness.close());

describe('every refusal comes before any write', () => {
	const membership = (input: Partial<Parameters<typeof putGroupMembership>[0]>) =>
		putGroupMembership({
			db,
			env,
			group,
			callerDid: CREATOR,
			writer,
			reader,
			subject: STRANGER,
			roles: ['member'],
			intent: 'admit',
			...input
		});
	const drop = (input: Partial<Parameters<typeof dropGroupMembership>[0]>) =>
		dropGroupMembership({
			db,
			env,
			group,
			callerDid: MEMBER,
			writer,
			reader,
			subject: ADMIN,
			intent: 'leave',
			...input
		});

	it.each([
		// Who may admit, assign or eject is the group's host's to decide; with
		// nobody signed in there is nobody to send the write as.
		[
			'an admit from an anonymous caller',
			() => membership({ callerDid: null }),
			GroupPermissionError
		],
		[
			'a membership that would grant no role at all',
			() => membership({ roles: [] }),
			GroupRecordError
		],
		[
			'a write before the members space exists',
			() => membership({ group: { ...group, members_space_uri: null } }),
			GroupRecordError
		],
		[
			'a write into a members space of another type',
			() =>
				membership({
					group: {
						...group,
						members_space_uri: `at://${group.group_did}/space/com.example.other/self`
					}
				}),
			/is not .*'s members space/
		],
		// The self-service pair is a member's own: aimed at anyone else, a join
		// would be an unguarded admit and a leave an unguarded eject.
		[
			'a join recorded for somebody else',
			() => membership({ callerDid: MEMBER, intent: 'join' }),
			GroupPermissionError
		],
		['a leave aimed at somebody else', () => drop({}), GroupPermissionError],
		[
			'the event bindings, from an anonymous caller',
			() => writeEventPermissions({ db, env, callerDid: null, group, writer, reader, bundles: {} }),
			GroupPermissionError
		]
	] as const)('refuses %s', async (_case, run, refusal) => {
		await expect(run()).rejects.toThrow(refusal);
		expect(writes).toEqual([]);
	});
});

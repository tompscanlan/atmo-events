// The member's acceptance around the host's join and leave: written after an open join
// admits them, deleted before they leave, both from their own session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';
import type { CallerSession } from './caller';
import { getMemberRow } from './db/roster';
import { hostMethods } from './host';
import { GROUP_ACCEPTANCE_COLLECTION } from '../members-record';
import { MEMBERS_SPACE_TYPE, type GroupRow } from '../types';

const MEMBER = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const GRANT = `space:${MEMBERS_SPACE_TYPE}?authority=*&collection=${GROUP_ACCEPTANCE_COLLECTION}&action=create&action=delete`;

let harness: SqliteD1;
let group: GroupRow;
let calls: string[];

function member(scope: string, answers: Record<string, unknown>): CallerSession {
	return {
		did: MEMBER,
		scope,
		async handle(pathname) {
			const nsid = pathname.replace(/^\/xrpc\//, '');
			calls.push(nsid);
			return Response.json(answers[nsid] ?? {});
		}
	};
}

beforeEach(async () => {
	({ harness, group } = await seedGroup({
		groupDid: GROUP_DID,
		creatorDid: 'did:plc:owner',
		name: 'Kona'
	}));
	calls = [];
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	harness.close();
	vi.restoreAllMocks();
});

const host = () => hostMethods({ db: harness.db, env: {}, group });

describe('an open join', () => {
	it('writes the acceptance once the host admits them', async () => {
		const session = member(`atproto ${GRANT}`, {
			'group.opensocial.requestJoin': { status: 'admitted' }
		});

		expect(await host().requestJoin({ callerDid: MEMBER, member: session }, null)).toBe('joined');

		expect(calls).toEqual(['group.opensocial.requestJoin', 'com.atproto.space.createRecord']);
		expect((await getMemberRow(harness.db, group.id, MEMBER))?.role).toBe('member');
	});

	it('writes none for a request left pending', async () => {
		const session = member(`atproto ${GRANT}`, {
			'group.opensocial.requestJoin': { status: 'pending' }
		});

		expect(await host().requestJoin({ callerDid: MEMBER, member: session }, null)).toBe('pending');

		expect(calls).toEqual(['group.opensocial.requestJoin']);
	});
});

describe('leaving', () => {
	it('deletes the acceptance before the host drops them', async () => {
		await host().leaveGroup({ callerDid: MEMBER, member: member(`atproto ${GRANT}`, {}) });

		expect(calls).toEqual(['com.atproto.space.deleteRecord', 'group.opensocial.leaveGroup']);
	});

	it('leaves all the same when the sign-in holds no grant to delete it', async () => {
		await host().leaveGroup({ callerDid: MEMBER, member: member('atproto', {}) });

		expect(calls).toEqual(['group.opensocial.leaveGroup']);
	});
});

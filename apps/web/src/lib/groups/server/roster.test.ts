// The caller's own half of a roster act at the group host: their acceptance
// (./acceptance.ts), written after a join and deleted before a leave, from
// their own session. Only that session touches it, and a refusal never stops
// the act: the acceptance decides how the roster shows a member, never what
// they may do. (Spec: FR-205, FR-206, FR-209.)
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import { spaceUri } from '../ids';
import type { MemberSession } from './acceptance';
import { memberGrant } from './member-grants';
import { accept, unaccept } from './roster';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');
const GROUP = { id: 'g1', group_did: GROUP_DID, members_space_uri: MEMBERS } as GroupRow;

/** A person's session at their own PDS, holding the group's grant. It records
 *  each call, and refuses each when `fail` is set. */
function session(did: string, { fail = false } = {}): MemberSession & { sent: string[] } {
	const sent: string[] = [];
	return {
		did,
		scope: memberGrant(GROUP_DID),
		sent,
		async handle(pathname) {
			sent.push(pathname);
			if (fail) return Response.json({ error: 'InternalServerError' }, { status: 500 });
			return Response.json(
				pathname.endsWith('createRecord') ? { uri: `${MEMBERS}/${did}/x/self`, cid: 'bafy' } : {}
			);
		}
	};
}

const ctx = (callerDid: string, member: MemberSession | null) => ({
	db: {} as D1Database,
	env: {},
	group: GROUP,
	callerDid,
	member
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each([
	['accept', accept, '/xrpc/com.atproto.space.createRecord'],
	['unaccept', unaccept, '/xrpc/com.atproto.space.deleteRecord']
] as const)('%s', (_, act, method) => {
	it('goes out on the caller’s own session', async () => {
		const own = session(MEMBER);

		await act(ctx(MEMBER, own));

		expect(own.sent).toEqual([method]);
	});

	// An admin's eject or deny must not touch the admin's own acceptance, nor
	// anyone's but the caller's.
	it('touches no session but the caller’s own, and none without one', async () => {
		const someoneElse = session(ADMIN);

		await act(ctx(MEMBER, someoneElse));
		await act(ctx(MEMBER, null));

		expect(someoneElse.sent).toEqual([]);
	});

	it('logs a refusal and goes on', async () => {
		const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const own = session(MEMBER, { fail: true });

		await expect(act(ctx(MEMBER, own))).resolves.toBeUndefined();

		expect(own.sent).toEqual([method]);
		expect(warned).toHaveBeenCalledTimes(1);
	});
});

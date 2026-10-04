// The remote forms, run through their real handlers.
//
// `$app/server` is stubbed so `form()` hands back the handler itself and
// `getRequestEvent()` answers with this file's caller and bindings. Everything
// after that is real: the route gate (`groupRouteContext`), the standing read,
// the sessions lookup and the schema.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => ({
	locals: { did: null as string | null },
	platform: { env: {} as Record<string, unknown> }
}));

/** The handler, tagged the way SvelteKit's loader checks every export of a
 *  `*.remote.ts` (`init_remote_functions`). */
vi.mock('$app/server', () => {
	const remote =
		(type: 'form' | 'command') =>
		(...args: unknown[]) =>
			Object.assign(args.at(-1) as object, { __: { type } });
	return { form: remote('form'), command: remote('command'), getRequestEvent: () => request };
});
// The people search reaches $lib/contrail, whose one runtime import from the UI
// package would pull in plyr's CSS, which Node's ESM loader rejects. Same
// pattern as ../search/server/query.test.ts.
vi.mock('@atmo-dev/events-ui', () => ({ getProfileUrl: vi.fn() }));
// A linked group's session, so the group's own writes reach the fake host.
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

import { sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { stubPds } from './server/__fixtures__/stub-pds';
import { linkGroups, linkedCredential, unlinkAllGroups } from './server/__fixtures__/linked-group';
import { createGroup, recordGroupSpaces } from './server/repo';
import { GroupCredentialError } from './server/event-writer';
import { acceptanceGrant } from './server/member-grants';
import { pdsProvisioner, provisionGroupSpaces } from './server/spaces';
import { formError } from './form-error';
import type { GroupFormResult } from './form-result';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from './types';
import { joinGroupForm, leaveGroupForm, updateGroupForm } from './groups.remote';

const OWNER = 'did:plc:owner';
const GROUP_DID = 'did:plc:unlinkedgroupaaaaaaaaaaa';

/** The handler `form()` was given, which is what the stub returned. */
const submitUpdate = updateGroupForm as unknown as (
	data: Record<string, unknown>
) => Promise<GroupFormResult>;

/** The handlers `form()` was given for the join and leave buttons. */
const submitJoin = joinGroupForm as unknown as (
	data: Record<string, unknown>
) => Promise<GroupFormResult>;
const submitLeave = leaveGroupForm as unknown as (
	data: Record<string, unknown>
) => Promise<GroupFormResult>;

let harness: SqliteD1;

beforeEach(() => {
	harness = sqliteD1();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	unlinkAllGroups();
	harness.close();
	request.locals = { did: null };
});

describe('a group whose owner has not linked it', () => {
	// Its members space cannot be read without the link, so nobody's
	// permissions are known. "Not allowed" would send the owner looking for a
	// role they already hold; the way out is the link, which only they can do.
	it('tells its owner to link the group when they save its settings', async () => {
		const row = await createGroup(harness.db, {
			groupDid: GROUP_DID,
			ownerDid: OWNER,
			name: 'Kona Trail Runners'
		});
		await recordGroupSpaces(harness.db, row.id, {
			aboutSpaceUri: `at://${GROUP_DID}/space/${ABOUT_SPACE_TYPE}/self`,
			membersSpaceUri: `at://${GROUP_DID}/space/${MEMBERS_SPACE_TYPE}/self`
		});
		request.locals.did = OWNER;
		request.platform.env = { DB: harness.db, ...linkGroups([]) };

		const result = await submitUpdate({
			groupDid: GROUP_DID,
			name: 'Kona Trail Runners',
			visibility: 'public',
			shownVisibility: 'public',
			requireApproval: true
		});

		expect(result).toEqual(formError(new GroupCredentialError(GROUP_DID)));
	});
});

// The caller's session is what writes their acceptance, so the forms have to
// hand it to the roster. The group's side runs against the fake host; the
// member's PDS is a session that records what it was asked.
describe('the join and leave buttons, for a member whose session holds the grant', () => {
	const LINKED = 'did:plc:linkedgroupaaaaaaaaaaaaa';
	const JOINER = 'did:plc:joineraaaaaaaaaaaaaaaaaa';

	it('a request writes the requester’s acceptance, and withdrawing it deletes it', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		stubPds({ did: LINKED, handle: 'linked.group.stub.test' });
		const row = await createGroup(harness.db, {
			groupDid: LINKED,
			ownerDid: OWNER,
			name: 'Linked'
		});
		const uris = await provisionGroupSpaces(
			pdsProvisioner(linkedCredential(LINKED), LINKED),
			'public'
		);
		await recordGroupSpaces(harness.db, row.id, uris);
		const asked: { nsid: string; space: unknown; repo: unknown }[] = [];
		const session = {
			did: JOINER,
			getTokenInfo: async () => ({ scope: `atproto ${acceptanceGrant(LINKED)}` }),
			handle: async (pathname: string, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as Record<string, unknown>;
				asked.push({ nsid: pathname, space: body.space, repo: body.repo });
				return Response.json({ uri: 'at://x', cid: 'bafy' });
			}
		};
		request.locals = { did: JOINER, session } as typeof request.locals;
		request.platform.env = { DB: harness.db, ...linkGroups([LINKED]) };

		expect(await submitJoin({ groupDid: LINKED })).toMatchObject({ ok: true, outcome: 'pending' });
		expect(await submitLeave({ groupDid: LINKED })).toMatchObject({
			ok: true,
			outcome: 'withdrawn'
		});

		expect(asked).toEqual([
			{
				nsid: '/xrpc/com.atproto.space.createRecord',
				space: uris.membersSpaceUri,
				repo: JOINER
			},
			{
				nsid: '/xrpc/com.atproto.space.deleteRecord',
				space: uris.membersSpaceUri,
				repo: JOINER
			}
		]);
	});
});

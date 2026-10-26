import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { OAuthResponseError } from '@atcute/oauth-node-client';

const request = vi.hoisted(() => ({
	locals: { did: null as string | null, session: null as unknown },
	platform: { env: {} as Record<string, unknown> }
}));

vi.mock('$app/server', () => {
	const remote =
		(type: 'form' | 'command') =>
		(...args: unknown[]) =>
			Object.assign(args.at(-1) as object, {
				__: { type },
				schema: args.length > 1 ? args[0] : undefined
			});
	return { form: remote('form'), command: remote('command'), getRequestEvent: () => request };
});
vi.mock('@atmo-dev/events-ui', () => ({ getProfileUrl: vi.fn() }));
/** Each sign-in's extra scopes, in order; `refuse` makes a PDS refuse any extra, or with
 *  'calendar' only the calendar type, as one where it does not resolve. */
const signIn = vi.hoisted(() => ({
	asked: [] as string[][],
	refuse: false as boolean | 'calendar'
}));
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./server/__fixtures__/linked-oauth-stub')).linkedOAuthStub,
	createOAuthClient: (_env: unknown, extras: readonly string[] = []) => ({
		authorize: async () => {
			signIn.asked.push([...extras]);
			const calendar = extras.some((s) => s.startsWith('space:rsvp.atmo.group.calendar'));
			if (
				(signIn.refuse === true && extras.length > 0) ||
				(signIn.refuse === 'calendar' && calendar)
			) {
				throw new OAuthResponseError(new Response(null, { status: 400 }), 'invalid_scope');
			}
			return { url: new URL(`https://pds.stub.test/oauth/authorize?extras=${extras.length}`) };
		}
	})
}));

import { isRowWrite, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { authzReader } from './server/__fixtures__/members-space';
import { atGroupHost, unlinkAllGroups } from './server/__fixtures__/linked-group';
import {
	fixtureSessions,
	readerSession,
	resetReaderHost,
	serveReader
} from './server/__fixtures__/reader-host';
import { seedGroup } from './server/__fixtures__/seed-group';
import { formError } from './form-error';
import { GROUP_SIGN_IN_SCOPES } from './server/sign-in-grants';
import type { GroupFormResult } from './form-result';
import { GroupCredentialError } from './server/session';
import { getGroupByDid } from './server/db/groups';
import { groupSpaceUris } from './ids';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord
} from './members-record';
import { ABOUT_SPACE_TYPE } from './types';
import * as groupRemotes from './group.remote';
import * as rosterRemotes from './roster.remote';
import { putGroupEvent, removeGroupEvent } from './group-events.remote';

const { createGroupForm, updateGroupForm } = groupRemotes;
const {
	addMemberForm,
	approveJoinRequestForm,
	changeMemberRoleForm,
	joinGroupForm,
	leaveGroupForm,
	rejectJoinRequestForm,
	removeMemberForm,
	signInForGroup
} = rosterRemotes;

const OWNER = 'did:plc:owneraaaaaaaaaaaaaaaaaaa';
const MEMBER = 'did:plc:memberaaaaaaaaaaaaaaaaaa';
const STRANGER = 'did:plc:strangeraaaaaaaaaaaaaaaa';
const GROUP = 'did:plc:linkedgroupaaaaaaaaaaaaa';
const NAME = 'Kona Trail Runners';
const META_ONLY = 'atproto space:group.opensocial.meta?authority=*&action=read';

type Handler = (data: Record<string, unknown>) => Promise<GroupFormResult<object>>;
const call = (remote: unknown, data: Record<string, unknown>) => (remote as Handler)(data);
const schemaOf = (remote: unknown) =>
	(remote as { schema: v.ObjectSchema<v.ObjectEntries, undefined> }).schema;

/** Everything any group form posts, so each handler finds its fields. */
const DATA = {
	groupDid: GROUP,
	name: 'Renamed',
	visibility: 'public',
	shownVisibility: 'public',
	joinPolicy: 'open',
	listed: true,
	member: MEMBER,
	did: MEMBER,
	actor: { did: MEMBER },
	role: 'member',
	rkey: '3lpaddle',
	intent: 'create',
	record: { name: 'Paddle' }
};

let harness: SqliteD1;

beforeEach(async () => {
	({ harness } = await seedGroup({
		groupDid: GROUP,
		creatorDid: OWNER,
		name: NAME,
		members: { [MEMBER]: 'member' }
	}));
	request.platform.env = {
		DB: harness.db,
		OAUTH_SESSIONS: fixtureSessions,
		OAUTH_PUBLIC_URL: 'https://atmo.stub.test'
	};
	signIn.asked = [];
	signIn.refuse = false;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	unlinkAllGroups();
	resetReaderHost();
	harness.close();
	request.locals = { did: null, session: null };
});

function host(isPublic = true) {
	serveReader(
		GROUP,
		authzReader(
			GROUP,
			{ [OWNER]: 'admin', [MEMBER]: 'member' },
			{
				records: [
					{
						space: groupSpaceUris(GROUP).aboutSpaceUri,
						collection: GROUP_ACCESS_COLLECTION,
						rkey: GROUP_ACCESS_RKEY,
						value: {
							$type: GROUP_ACCESS_COLLECTION,
							...groupAccessRecord({
								spaceType: ABOUT_SPACE_TYPE,
								roles: ABOUT_SPACE_READER_ROLES,
								public: isPublic
							})
						}
					}
				]
			}
		)
	);
}

function signInAs(did: string, scope?: string) {
	request.locals = { did, session: readerSession(did, scope) };
}

const rowWrites = () => harness.statements.filter(isRowWrite);

const GATED = [
	['the settings save', updateGroupForm, 'MANAGE_GROUP'],
	['approving a request', approveJoinRequestForm, 'ADMIT_MEMBERS'],
	['rejecting a request', rejectJoinRequestForm, 'ADMIT_MEMBERS'],
	['adding a member', addMemberForm, 'ADMIT_MEMBERS'],
	['removing a member', removeMemberForm, 'EJECT_MEMBERS'],
	['changing a role', changeMemberRoleForm, 'ASSIGN_ROLES']
] as const;

describe('the forms’ schemas', () => {
	it('a create takes the settings, a list-this-group box and the rules, and nothing else', () => {
		const schema = schemaOf(createGroupForm);
		expect(Object.keys(schema.entries).sort()).toEqual(
			['description', 'joinPolicy', 'listed', 'name', 'rules', 'visibility'].sort()
		);
		const create = { name: NAME, visibility: 'private', joinPolicy: 'invite', rules: 'Be kind' };
		expect(v.parse(schema, { ...create, listed: 'on' })).toMatchObject({ listed: true });
		expect(v.parse(schema, create)).toMatchObject({ listed: false });
	});

	it('a settings save takes the same, the visibility shown, and no rules', () => {
		expect(Object.keys(schemaOf(updateGroupForm).entries).sort()).toEqual(
			[
				'description',
				'groupDid',
				'joinPolicy',
				'listed',
				'name',
				'shownVisibility',
				'visibility'
			].sort()
		);
	});

	it.each([
		['an empty name', { name: '  ' }],
		['a name over 64 graphemes', { name: 'é'.repeat(65) }],
		['a description over 2,000 graphemes', { description: 'x'.repeat(2001) }],
		['an unknown join policy', { joinPolicy: 'anyone' }],
		['a rule over 2,000 graphemes', { rules: `Be kind\n${'x'.repeat(2001)}` }]
	])('refuses %s', (_, change) => {
		const create = { name: NAME, visibility: 'public', joinPolicy: 'open', ...change };
		expect(v.safeParse(schemaOf(createGroupForm), create).success).toBe(false);
	});

	it('offers no refresh and no handle suggestions', () => {
		expect(Object.keys(groupRemotes).sort()).toEqual([
			'createGroupForm',
			'finishGroupSetupCommand',
			'updateGroupForm'
		]);
		expect(rosterRemotes).not.toHaveProperty('suggestPeople');
	});
});

describe('the gate in front of the group forms', () => {
	it.each<[string, unknown]>([
		...GATED.map(([name, remote]): [string, unknown] => [name, remote]),
		['joining', joinGroupForm],
		['leaving', leaveGroupForm],
		['writing an event', putGroupEvent],
		['deleting an event', removeGroupEvent],
		['the sign-in button', signInForGroup],
		['finishing a stopped create', groupRemotes.finishGroupSetupCommand]
	])('refuses %s to a signed-out caller with a 401, before any read', async (_, remote) => {
		host();
		await expect(call(remote, DATA)).rejects.toMatchObject({ status: 401 });
		expect(fixtureSessions.reads).toBe(0);
		expect(vi.mocked(fetch).mock.calls).toEqual([]);
	});

	it.each(GATED)(
		'refuses %s to a member without %s, and writes nothing',
		async (_, remote, permission) => {
			host();
			signInAs(MEMBER);
			harness.statements.length = 0;

			const result = await call(remote, DATA);

			expect(result, permission).toMatchObject({ ok: false, reason: 'permission-denied' });
			expect(rowWrites()).toEqual([]);
			expect((await getGroupByDid(harness.db, GROUP))?.name).toBe(NAME);
		}
	);

	it.each([
		['writing an event', putGroupEvent],
		['deleting an event', removeGroupEvent]
	])('answers a member %s with a refusal, not a 500', async (_, remote) => {
		host();
		signInAs(MEMBER);
		expect(await call(remote, DATA)).toMatchObject({ ok: false });
	});

	it.each(GATED)(
		'asks an admin whose sign-in reads no members space to sign in again for %s',
		async (_, remote) => {
			host();
			signInAs(OWNER, META_ONLY);
			harness.statements.length = 0;

			expect(await call(remote, DATA)).toMatchObject({ ok: false, reason: 'sign-in-required' });
			expect(rowWrites()).toEqual([]);
		}
	);

	it.each(GATED)(
		'answers %s on a private group the caller cannot read with the 404',
		async (_, remote) => {
			host(false);
			signInAs(OWNER, META_ONLY);
			await expect(call(remote, DATA)).rejects.toMatchObject({ status: 404 });
			signInAs(STRANGER);
			await expect(call(remote, DATA)).rejects.toMatchObject({ status: 404 });
		}
	);

	it('tells an owner with no group session to link one when they save the settings', async () => {
		host();
		signInAs(OWNER);
		const noSessions = { get: async () => null } as unknown as KVNamespace;
		request.platform.env = atGroupHost({ ...request.platform.env, OAUTH_SESSIONS: noSessions });
		harness.statements.length = 0;

		expect(await call(updateGroupForm, DATA)).toEqual(
			formError(new GroupCredentialError(GROUP, OWNER))
		);
		expect(rowWrites()).toEqual([]);
	});
});

describe('the sign-in button', () => {
	beforeEach(() => {
		host(false);
		request.platform.env = { ...request.platform.env, GROUP_HOST_URL: 'https://pds.stub.test' };
	});

	it('asks the groups permission set and the RSVP grant for a member a private group hides, and less when the PDS refuses', async () => {
		const participate = 'include:group.opensocial.participate';
		signInAs(OWNER, META_ONLY);
		expect(await call(signInForGroup, { groupDid: GROUP })).toBe(
			'https://pds.stub.test/oauth/authorize?extras=2'
		);
		expect(signIn.asked).toEqual([[...GROUP_SIGN_IN_SCOPES]]);

		signIn.asked = [];
		signIn.refuse = 'calendar';
		expect(await call(signInForGroup, { groupDid: GROUP })).toBe(
			'https://pds.stub.test/oauth/authorize?extras=1'
		);
		expect(signIn.asked).toEqual([[...GROUP_SIGN_IN_SCOPES], [participate]]);

		signIn.asked = [];
		signIn.refuse = true;
		expect(await call(signInForGroup, { groupDid: GROUP })).toBe(
			'https://pds.stub.test/oauth/authorize?extras=0'
		);
		expect(signIn.asked).toEqual([[...GROUP_SIGN_IN_SCOPES], [participate], []]);
	});

	it('answers someone the row does not list with the 404', async () => {
		signInAs(STRANGER, META_ONLY);
		await expect(call(signInForGroup, { groupDid: GROUP })).rejects.toMatchObject({ status: 404 });
		expect(signIn.asked).toEqual([]);
	});
});

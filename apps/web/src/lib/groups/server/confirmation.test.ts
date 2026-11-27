import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { memoryKV, type MemoryKV } from './__fixtures__/kv';
import {
	confirmAdmitted,
	confirmMembership,
	deleteConfirmation,
	forgetJoinRequest,
	hasConfirmation,
	joinRequested,
	rememberJoinRequest,
	withdrawConfirmation,
	writeConfirmation
} from './confirmation';
import type { XrpcHandle } from './xrpc';

const ALICE = 'did:plc:alice';
const GROUP = 'did:plc:group';
const MEMBERS = `at:space/${GROUP}/org.atgrp.members/self`;
/** The participate set's members-space grant, as a PDS hands it back expanded. */
const GRANT = 'space:org.atgrp.members?authority=*&skey=self&collection=org.atgrp.confirmation';

function member(scope = `atproto ${GRANT}`, answer: () => Response = () => Response.json({})) {
	const handle = vi.fn<XrpcHandle>(async () => answer());
	return { did: ALICE, scope, handle };
}

const body = (handle: ReturnType<typeof member>['handle']) =>
	JSON.parse(String(handle.mock.calls[0][1].body));

let kv: MemoryKV;

beforeEach(() => {
	vi.restoreAllMocks();
	kv = memoryKV();
	Object.assign(env, { OAUTH_SESSIONS: kv });
});

describe('a request to join made here', () => {
	it('is noted under the person, for that group, until it is forgotten', async () => {
		expect(await joinRequested(ALICE, GROUP)).toBe(false);
		await rememberJoinRequest(ALICE, GROUP);
		expect(await joinRequested(ALICE, GROUP)).toBe(true);
		expect(await joinRequested(ALICE, 'did:plc:other')).toBe(false);
		expect(await joinRequested('did:plc:bob', GROUP)).toBe(false);
		expect(kv.ttlOf(`group:join-requested:${ALICE}/${GROUP}`)).toBe(90 * 24 * 60 * 60);
		await forgetJoinRequest(ALICE, GROUP);
		expect(await joinRequested(ALICE, GROUP)).toBe(false);
	});

	it('once admitted, has the confirmation written and is then forgotten', async () => {
		await rememberJoinRequest(ALICE, GROUP);
		const person = member();
		await confirmAdmitted(person, GROUP);
		expect(person.handle.mock.calls[0][0]).toBe('/xrpc/com.atproto.space.createRecord');
		expect(await joinRequested(ALICE, GROUP)).toBe(false);
	});

	it('is kept when the confirmation could not be written, for the next visit', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await rememberJoinRequest(ALICE, GROUP);
		await confirmAdmitted(
			member(undefined, () => new Response('', { status: 502 })),
			GROUP
		);
		expect(await joinRequested(ALICE, GROUP)).toBe(true);
	});
});

describe('whether a member confirmed', () => {
	it("reads their own confirmation in the group's members space", async () => {
		const get = vi.fn(async () => ({ uri: 'x', cid: 'c', value: {} }));
		expect(await hasConfirmation({ get } as never, GROUP, ALICE)).toBe(true);
		expect(get).toHaveBeenCalledWith({
			space: MEMBERS,
			repo: ALICE,
			collection: 'org.atgrp.confirmation',
			rkey: 'self'
		});
		get.mockResolvedValue(null as never);
		expect(await hasConfirmation({ get } as never, GROUP, ALICE)).toBe(false);
	});
});

describe("a member's confirmation", () => {
	it("is created in the person's own repo in the group's members space, keyed self", async () => {
		const person = member();
		const now = new Date('2026-11-26T12:00:00.000Z');
		expect(await writeConfirmation(person, GROUP, now)).toBe('written');
		expect(person.handle.mock.calls[0][0]).toBe('/xrpc/com.atproto.space.createRecord');
		expect(body(person.handle)).toEqual({
			space: MEMBERS,
			repo: ALICE,
			collection: 'org.atgrp.confirmation',
			rkey: 'self',
			record: { $type: 'org.atgrp.confirmation', createdAt: '2026-11-26T12:00:00.000Z' }
		});
	});

	it('keeps one already there, and is skipped without the grant, as on a PDS without spaces', async () => {
		const present = member(undefined, () =>
			Response.json({ error: 'RecordAlreadyExists' }, { status: 400 })
		);
		expect(await writeConfirmation(present, GROUP)).toBe('present');

		const none = member('atproto');
		expect(await writeConfirmation(none, GROUP)).toBe('skipped');
		expect(await deleteConfirmation(none, GROUP)).toBe('skipped');
		expect(none.handle).not.toHaveBeenCalled();
	});

	it('is deleted from the same place', async () => {
		const person = member();
		expect(await deleteConfirmation(person, GROUP)).toBe('deleted');
		expect(person.handle.mock.calls[0][0]).toBe('/xrpc/com.atproto.space.deleteRecord');
		expect(body(person.handle)).toEqual({
			space: MEMBERS,
			repo: ALICE,
			collection: 'org.atgrp.confirmation',
			rkey: 'self'
		});
	});

	it('never throws on a visit or a leave: a later visit writes it again', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const failing = member(undefined, () => new Response('', { status: 500 }));
		await expect(confirmMembership(failing, GROUP)).resolves.toBeUndefined();
		await expect(withdrawConfirmation(failing, GROUP)).resolves.toBeUndefined();
		expect(failing.handle).toHaveBeenCalledTimes(2);
	});
});

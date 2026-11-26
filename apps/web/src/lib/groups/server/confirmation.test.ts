import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	confirmMembership,
	deleteConfirmation,
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

beforeEach(() => {
	vi.restoreAllMocks();
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

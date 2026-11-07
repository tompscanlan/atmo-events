import { describe, expect, it, vi } from 'vitest';
import { accept, deleteAcceptance, writeAcceptance } from './acceptance';
import type { CallerSession } from './caller';

const GROUP = 'did:plc:group';
const MEMBER = 'did:plc:member';
const GRANT = `space:group.opensocial.members?authority=*&skey=self&collection=group.opensocial.acceptance`;

function member(answer: Response, scope = GRANT): CallerSession {
	return { did: MEMBER, scope, handle: vi.fn(async () => answer) };
}

describe('the acceptance', () => {
	it('is written in the member’s own repo in the group’s members space', async () => {
		const m = member(Response.json({ uri: 'x', cid: 'y' }));
		const now = new Date('2026-10-30T12:00:00Z');
		expect(await writeAcceptance(m, GROUP, now)).toBe('written');
		const [pathname, init] = vi.mocked(m.handle).mock.calls[0];
		expect(pathname).toBe('/xrpc/com.atproto.space.createRecord');
		expect(JSON.parse(String(init.body))).toEqual({
			space: `at://${GROUP}/space/group.opensocial.members/self`,
			repo: MEMBER,
			collection: 'group.opensocial.acceptance',
			rkey: 'self',
			record: { $type: 'group.opensocial.acceptance', createdAt: now.toISOString() }
		});
	});

	it('is left as it was when it already exists', async () => {
		const m = member(Response.json({ error: 'RecordAlreadyExists' }, { status: 400 }));
		expect(await writeAcceptance(m, GROUP)).toBe('present');
	});

	it('is skipped, with nothing sent, without the grant', async () => {
		const m = member(Response.json({}), 'atproto');
		expect(await writeAcceptance(m, GROUP)).toBe('skipped');
		expect(await deleteAcceptance(m, GROUP)).toBe('skipped');
		expect(m.handle).not.toHaveBeenCalled();
	});

	it('never fails the visit it was written on', async () => {
		const m = member(Response.json({ error: 'InternalServerError' }, { status: 500 }));
		await expect(writeAcceptance(m, GROUP)).rejects.toThrow();
		expect(await accept(m, GROUP)).toBe(false);
	});
});

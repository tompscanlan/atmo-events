// The one XRPC helper every group transport sends through. What it promises:
// a failure is worded `<method> failed: <status> <error>` and never carries the
// PDS's message, and only RecordNotFound reads as absent. How it encodes a
// request is exercised by every test that talks to a stub PDS.
import { describe, expect, it } from 'vitest';
import { isRecordNotFound, readXrpc, repoRecordExists, xrpcError, type XrpcHandle } from './xrpc';

/** A handle that answers every request with `reply`. */
function answering(reply: () => Response): XrpcHandle {
	return async () => reply();
}

describe('readXrpc', () => {
	it('keeps a refusal’s error name and message apart', async () => {
		const answer = await readXrpc(
			Response.json({ error: 'InvalidRequest', message: 'name was "kona x"' }, { status: 400 })
		);
		expect(answer).toEqual({
			ok: false,
			status: 400,
			error: 'InvalidRequest',
			message: 'name was "kona x"'
		});
	});

	it('reads a body that is not JSON as empty, on success and on failure', async () => {
		expect(await readXrpc(new Response('ok', { status: 200 }))).toEqual({
			ok: true,
			status: 200,
			data: {}
		});
		expect(await readXrpc(new Response('<html>bad gateway', { status: 502 }))).toEqual({
			ok: false,
			status: 502,
			error: null,
			message: null
		});
	});
});

describe('xrpcError', () => {
	// The message can carry what a user typed, so the wording never includes it.
	it('names the method, the status and the error, and never the message', () => {
		const error = xrpcError('com.atproto.server.createAccount', {
			status: 400,
			error: 'InvalidHandle'
		});
		expect(error.message).toBe('com.atproto.server.createAccount failed: 400 InvalidHandle');
		expect(xrpcError('m', { status: 502, error: null }).message).toBe('m failed: 502');
	});
});

describe('absence', () => {
	it('is only a 400 RecordNotFound', () => {
		const refusal = (status: number, error: string | null) =>
			({ ok: false, status, error, message: null }) as const;
		expect(isRecordNotFound(refusal(400, 'RecordNotFound'))).toBe(true);
		expect(isRecordNotFound(refusal(500, 'RecordNotFound'))).toBe(false);
		expect(isRecordNotFound(refusal(400, 'InvalidRequest'))).toBe(false);
		expect(isRecordNotFound({ ok: true, status: 200, data: {} })).toBe(false);
	});

	it('repoRecordExists answers true, false, or throws on anything else', async () => {
		expect(
			await repoRecordExists(
				answering(() => Response.json({})),
				'r',
				'c',
				'k'
			)
		).toBe(true);
		expect(
			await repoRecordExists(
				answering(() => Response.json({ error: 'RecordNotFound' }, { status: 400 })),
				'r',
				'c',
				'k'
			)
		).toBe(false);
		await expect(
			repoRecordExists(
				answering(() => Response.json({ error: 'InternalServerError' }, { status: 500 })),
				'r',
				'c',
				'k'
			)
		).rejects.toThrow('com.atproto.repo.getRecord failed: 500 InternalServerError');
	});
});

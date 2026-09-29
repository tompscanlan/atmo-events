// A refused submit must leave the form as the user typed it. SvelteKit's
// default resets a remote form after any response without validation issues,
// and the group handlers report a refusal as a result (`{ ok: false }`), so the
// default emptied the form the user was about to correct.
//
// The fake stands in for a remote form: `enhance` hands back the callback the
// page would attach, and `submit` sets `result` the way the real one does.
import { describe, it, expect, vi } from 'vitest';
import { resetOnSuccess } from './form-enhance';

type Result = { ok: true } | { ok: false; error: string } | undefined;

function fakeRemoteForm(next: Result) {
	let callback:
		| ((opts: { form: HTMLFormElement; submit: () => Promise<void> }) => Promise<void>)
		| undefined;
	const remote = {
		result: undefined as Result,
		enhance(cb: NonNullable<typeof callback>) {
			callback = cb;
			return { method: 'POST' as const, action: '?/remote' };
		}
	};
	const form = { reset: vi.fn() } as unknown as HTMLFormElement & {
		reset: ReturnType<typeof vi.fn>;
	};
	const attributes = resetOnSuccess(remote);
	async function submitOnce() {
		await callback!({
			form,
			submit: async () => {
				remote.result = next;
			}
		});
	}
	return { attributes, form, submitOnce };
}

describe('resetOnSuccess', () => {
	it('returns the attributes the remote form gives the page', () => {
		const { attributes } = fakeRemoteForm({ ok: true });
		expect(attributes).toEqual({ method: 'POST', action: '?/remote' });
	});

	it('resets the form after the handler succeeded', async () => {
		const { form, submitOnce } = fakeRemoteForm({ ok: true });
		await submitOnce();
		expect(form.reset).toHaveBeenCalledOnce();
	});

	it('keeps the input when the handler refused', async () => {
		const { form, submitOnce } = fakeRemoteForm({ ok: false, error: 'walk-0929 is already taken' });
		await submitOnce();
		expect(form.reset).not.toHaveBeenCalled();
	});

	// A response with validation issues carries no result.
	it('keeps the input when there is no result', async () => {
		const { form, submitOnce } = fakeRemoteForm(undefined);
		await submitOnce();
		expect(form.reset).not.toHaveBeenCalled();
	});
});

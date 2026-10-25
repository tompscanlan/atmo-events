import { describe, it, expect, vi } from 'vitest';
import { resetOnSuccess } from './form-result';

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
	resetOnSuccess(remote);
	async function submitOnce() {
		await callback!({
			form,
			submit: async () => {
				remote.result = next;
			}
		});
	}
	return { form, submitOnce };
}

describe('resetOnSuccess', () => {
	it('resets the form after the handler succeeded', async () => {
		const { form, submitOnce } = fakeRemoteForm({ ok: true });
		await submitOnce();
		expect(form.reset).toHaveBeenCalledOnce();
	});

	it.each([
		['the handler refused', { ok: false as const, error: 'taken' }],
		['there is no result, as with validation issues', undefined]
	])('keeps the input when %s', async (_, result) => {
		const { form, submitOnce } = fakeRemoteForm(result);
		await submitOnce();
		expect(form.reset).not.toHaveBeenCalled();
	});
});

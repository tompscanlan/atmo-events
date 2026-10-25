// Annotate `GroupFormResult<…>`: a bare `{ ok: true }` widens to `{ ok: boolean }`.

export interface GroupFormFailure {
	ok: false;
	error: string;
	reason?: 'sign-in-required' | 'no-space-access' | 'members-unreadable' | 'permission-denied';
}

export type GroupFormSuccess<TDone extends object = Record<never, never>> = { ok: true } & TDone;

export type GroupFormResult<TDone extends object = Record<never, never>> =
	| GroupFormSuccess<TDone>
	| GroupFormFailure;

export function groupFormError(
	result: GroupFormResult<object> | undefined | null
): string | undefined {
	return result && !result.ok ? result.error : undefined;
}

// SvelteKit resets a remote form after any valid response, a refusal included.
interface GroupRemoteForm<TAttributes> {
	readonly result: { ok: boolean } | undefined;
	enhance(
		callback: (opts: { form: HTMLFormElement; submit: () => Promise<void> }) => Promise<void>
	): TAttributes;
}

/** Use as `<form {...resetOnSuccess(someForm)}>`. Resets only on success. */
export function resetOnSuccess<TAttributes>(remote: GroupRemoteForm<TAttributes>): TAttributes {
	return remote.enhance(async ({ form, submit }) => {
		await submit();
		if (remote.result?.ok) form.reset();
	});
}

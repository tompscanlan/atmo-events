// What every group form resolves to, and the one way a page resets a form after it.
// Handlers annotate their return type as `GroupFormResult<…>`, because an
// un-annotated `{ ok: true }` widens to `{ ok: boolean }` and lets a page read
// `.error` off a success. Client-safe: the pages import it.

export interface GroupFormFailure {
	ok: false;
	error: string;
}

export type GroupFormSuccess<TDone extends object = Record<never, never>> = { ok: true } & TDone;

export type GroupFormResult<TDone extends object = Record<never, never>> =
	| GroupFormSuccess<TDone>
	| GroupFormFailure;

/** The only way from a result to its `error`. Takes the `undefined` a form's
 *  `result` starts as. */
export function groupFormError(
	result: GroupFormResult<object> | undefined | null
): string | undefined {
	return result && !result.ok ? result.error : undefined;
}

// SvelteKit resets a remote form after any response without validation issues,
// but a group handler's refusal (`{ ok: false }`) must keep the user's input.
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

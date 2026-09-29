// What every group form in `./groups.remote.ts` resolves to. Handlers annotate their
// return type as `GroupFormResult<…>`, because an un-annotated `{ ok: true }` widens
// to `{ ok: boolean }` and lets a page read `.error` off a success.

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

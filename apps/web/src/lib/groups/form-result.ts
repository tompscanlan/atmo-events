// The shape every group form in `./groups.remote.ts` resolves to, and the one
// way a page is allowed to read the message out of it.
//
// This lives beside the remote module rather than inside it because a
// `*.remote.ts` module may only export remote functions: SvelteKit replaces it
// on the client with generated call proxies, so a plain helper exported from
// there would not survive the trip.
//
// `ok` is a literal discriminant, not a boolean. `{ ok: true }` returned from an
// un-annotated handler widens to `{ ok: boolean }`, which erases the union and
// lets a page read `.error` off a success. So every handler annotates its
// return type as `GroupFormResult<…>`, and pages narrow with `groupFormError` /
// `result.ok`.

/** A handler that refused, with the message the form renders. */
export interface GroupFormFailure {
	ok: false;
	error: string;
}

/** A handler that succeeded, plus whatever it has to tell the page. */
export type GroupFormSuccess<TDone extends object = Record<never, never>> = { ok: true } & TDone;

export type GroupFormResult<TDone extends object = Record<never, never>> =
	| GroupFormSuccess<TDone>
	| GroupFormFailure;

/** The message, or `undefined` when there is none. This is the only way from a
 *  result to its `error`. Accepts the `undefined` a form's `result` starts as,
 *  so a page can write `groupFormError(someForm.result)` directly. */
export function groupFormError(
	result: GroupFormResult<object> | undefined | null
): string | undefined {
	return result && !result.ok ? result.error : undefined;
}

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

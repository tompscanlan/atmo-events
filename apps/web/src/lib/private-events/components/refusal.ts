/** What a refused command says, in the words the server gave it; anything else in plain words. */
export function refusalWords(e: unknown): string {
	const message = (e as { body?: { message?: unknown } } | null)?.body?.message;
	return typeof message === 'string' ? message : 'That did not work. Try again.';
}

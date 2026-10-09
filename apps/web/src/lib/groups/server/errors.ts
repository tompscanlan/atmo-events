// What the groups code needs to say about an error it caught.

/** An error's message, or the thrown value as text when it is not an Error. */
export function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

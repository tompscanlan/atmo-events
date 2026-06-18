/**
 * Keep the first occurrence of each uri, preserving order.
 *
 * Guards the keyed `{#each ... (event.uri)}` lists (e.g. EventList): a data
 * source can return the same record more than once — notably the D1 full-text
 * search path, where an event joined to duplicate `fts` rows fans out into
 * identical rows. A repeated key makes Svelte throw `each_key_duplicate` during
 * hydration, which unmounts the page (renders blank after a flash of content).
 * Deduping by uri keeps the keys unique regardless of how dirty the source is.
 */
export function dedupeByUri<T extends { uri: string }>(items: T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		if (seen.has(item.uri)) continue;
		seen.add(item.uri);
		out.push(item);
	}
	return out;
}

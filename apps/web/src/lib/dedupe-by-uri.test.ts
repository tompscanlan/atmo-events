import { describe, expect, it } from 'vitest';
import { dedupeByUri } from './dedupe-by-uri';

describe('dedupeByUri', () => {
	it('collapses repeated uris to the first occurrence, preserving order', () => {
		const items = [
			{ uri: 'at://a', name: 'first' },
			{ uri: 'at://b', name: 'second' },
			{ uri: 'at://a', name: 'duplicate of first' },
			{ uri: 'at://c', name: 'third' }
		];

		expect(dedupeByUri(items)).toEqual([
			{ uri: 'at://a', name: 'first' },
			{ uri: 'at://b', name: 'second' },
			{ uri: 'at://c', name: 'third' }
		]);
	});

	it('yields a uri-unique list so a keyed {#each} cannot collide on duplicate keys', () => {
		// An FTS fan-out (one record joined to duplicate fts rows) returns the same
		// event twice. The keyed each in EventList crashes hydration on a repeated
		// key, blanking the page; deduping by uri is what prevents that.
		const items = [{ uri: 'at://x' }, { uri: 'at://x' }, { uri: 'at://x' }];

		const result = dedupeByUri(items);

		expect(result).toHaveLength(1);
		expect(new Set(result.map((r) => r.uri)).size).toBe(result.length);
	});

	it('returns an empty array unchanged', () => {
		expect(dedupeByUri([])).toEqual([]);
	});

	it('leaves an already-unique list untouched', () => {
		const items = [{ uri: 'at://a' }, { uri: 'at://b' }];
		expect(dedupeByUri(items)).toEqual(items);
	});
});

// The codegen copies in lexicons/custom, checked against what
// scripts/lexicon-shims.mjs derives from the reference lexicons. A hand edit, or
// a reference that changed without a `pnpm generate`, fails here.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { LEX_CONFIG, SHIMS, shimLexicon } from '../../../scripts/lexicon-shims.mjs';

const read = (path: string) => readFileSync(path, 'utf8');

/** The parsed lexicon with every `space-ref` format changed to `uri`, worked
 *  out on the structure rather than the text the script edits. */
function withUriFormats(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withUriFormats);
	if (typeof value !== 'object' || value === null) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, v]) => [
			key,
			key === 'format' && v === 'space-ref' ? 'uri' : withUriFormats(v)
		])
	);
}

describe('lexicon shims', () => {
	for (const { nsid, reference, shim } of SHIMS) {
		it(`${nsid}: the committed copy is the script's output for the reference`, () => {
			expect(read(shim)).toBe(shimLexicon(read(reference)));
		});

		it(`${nsid}: the copy differs from the reference only in its space-ref formats`, () => {
			const referenceText = read(reference);
			expect(referenceText).toContain('"space-ref"');
			expect(JSON.parse(shimLexicon(referenceText))).toEqual(
				withUriFormats(JSON.parse(referenceText))
			);
		});
	}

	it('lex.config.js pulls none of the copied NSIDs', () => {
		const config = read(LEX_CONFIG);
		for (const { nsid } of SHIMS) expect(config).not.toContain(`"${nsid}"`);
	});
});

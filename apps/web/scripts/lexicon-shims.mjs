#!/usr/bin/env node
/**
 * Codegen copies of lexicons the tooling cannot read yet; `pnpm generate` runs this first.
 * @atcute/lex-cli rejects the `space-ref` format, so a copy in lexicons/custom says `uri` in
 * its place. The Atmosphere Groups declaration has no fields, so its copy is the reference
 * unchanged. When the tooling reads `space-ref`, delete the copy, this script, its test and
 * its step in `pnpm generate`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = (/** @type {string} */ rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

export const SHIMS = [
	{
		nsid: 'org.atgrp.declaration',
		reference: path('lexicons/reference/org/atgrp/declaration.json'),
		shim: path('lexicons/custom/org/atgrp/declaration.json')
	}
];

const SPACE_REF = /("format"\s*:\s*)"space-ref"/g;

/**
 * Text, not re-serialized JSON, so the copy keeps the reference's layout.
 * @param {string} text
 */
export function shimLexicon(text) {
	return text.replace(SPACE_REF, '$1"uri"');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	for (const { reference, shim } of SHIMS) {
		writeFileSync(shim, shimLexicon(readFileSync(reference, 'utf8')));
	}
}

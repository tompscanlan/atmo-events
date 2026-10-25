#!/usr/bin/env node
/**
 * Codegen copies of lexicons the tooling cannot read yet; `pnpm generate` runs `write`
 * before contrail-lex generate and `unpull` after. The declaration's `meta` has the
 * proposal's `space-ref` format, which @atcute/lex-cli rejects, so its copy in
 * lexicons/custom says `uri`. Its NSID does not resolve, so it leaves the pull list.
 * When the copy goes: src/lib/groups/README.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = (/** @type {string} */ rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

export const SHIMS = [
	{
		nsid: 'group.opensocial.declaration',
		reference: path('lexicons/reference/group/opensocial/declaration.json'),
		shim: path('lexicons/custom/group/opensocial/declaration.json')
	}
];

export const LEX_CONFIG = path('lex.config.js');

const SPACE_REF = /("format"\s*:\s*)"space-ref"/g;

/**
 * Text, not re-serialized JSON, so the copy keeps the reference's layout.
 * @param {string} text
 */
export function shimLexicon(text) {
	return text.replace(SPACE_REF, '$1"uri"');
}

const PULL_LIST = /(nsids: )(\[[^\]]*\])/;

/**
 * @param {string} text
 * @param {readonly string[]} nsids
 */
export function unpull(text, nsids) {
	const match = text.match(PULL_LIST);
	if (!match) throw new Error('lex.config.js has no `nsids: [...]` pull list to edit');
	/** @type {string[]} */
	const pulled = JSON.parse(match[2]);
	const kept = pulled.filter((nsid) => !nsids.includes(nsid));
	// contrail-lex's formatting, so a file it just wrote changes only by the dropped lines.
	const list = JSON.stringify(kept, null, 10).replace(/^/gm, '        ').trim();
	return text.replace(PULL_LIST, (_, head) => head + list);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const step = process.argv[2];
	if (step === 'write') {
		for (const { reference, shim } of SHIMS) {
			writeFileSync(shim, shimLexicon(readFileSync(reference, 'utf8')));
		}
	} else if (step === 'unpull') {
		const nsids = SHIMS.map((s) => s.nsid);
		writeFileSync(LEX_CONFIG, unpull(readFileSync(LEX_CONFIG, 'utf8'), nsids));
	} else {
		console.error('usage: node scripts/lexicon-shims.mjs write|unpull');
		process.exit(2);
	}
}

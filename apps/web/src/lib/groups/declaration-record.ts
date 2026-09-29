// The one record a group publishes to the anonymous web, in its public repo. A space
// refuses anonymous readers even under a public policy, so this pointer is how a peer
// app learns that a DID is a group. Only a public group has one.
import type { GroupVisibility } from './types';

export const GROUP_DECLARATION_COLLECTION = 'net.openmeet.group.declaration';
export const GROUP_DECLARATION_RKEY = 'self';

export interface GroupDeclarationInput {
	aboutSpaceUri: string;
	/** Carried across a rewrite so a group that flips private and back keeps its date. */
	createdAt?: string | null;
}

/** `{ aboutSpace, createdAt }` and nothing else. The draft publishes no lexicon, so
 *  the field name is provisional. There is no parser: the app never reads it back. */
export function groupDeclarationRecord(input: GroupDeclarationInput): Record<string, unknown> {
	// `$type` is stamped by the writer, which owns the collection name.
	return {
		aboutSpace: input.aboutSpaceUri,
		createdAt: input.createdAt || new Date().toISOString()
	};
}

/** Anything but `public` is not declared, so a value nobody chose never announces a group. */
export function declarationRequired(visibility: GroupVisibility): boolean {
	return visibility === 'public';
}

// A group's declaration, in its public repo: how a peer app learns that a DID is a
// group. Only a public group that chose to be listed has one.
export const GROUP_DECLARATION_COLLECTION = 'group.opensocial.declaration';
export const GROUP_DECLARATION_RKEY = 'self';

export function groupDeclarationRecord(input: { aboutSpaceUri: string }): Record<string, unknown> {
	return { meta: input.aboutSpaceUri };
}

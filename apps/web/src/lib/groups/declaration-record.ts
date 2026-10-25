export const GROUP_DECLARATION_COLLECTION = 'group.opensocial.declaration';
export const GROUP_DECLARATION_RKEY = 'self';

export function groupDeclarationRecord(input: { aboutSpaceUri: string }): Record<string, unknown> {
	return { meta: input.aboutSpaceUri };
}

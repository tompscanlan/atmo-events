/** URL slug for a group name. Lossy on purpose — non-ASCII names collapse to
 *  empty and get the fallback, because a slug is a handle for humans typing a
 *  URL, not a faithful encoding of the name (which lives in `groups.name`). */
export function slugifyGroupName(name: string): string {
	const slug = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48)
		.replace(/-+$/g, '');
	return slug || 'group';
}

export const GROUP_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;

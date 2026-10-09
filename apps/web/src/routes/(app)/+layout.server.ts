import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ platform }) => {
	return { groupsEnabled: Boolean(platform?.env.GROUP_PDS_SERVICE?.trim()) };
};

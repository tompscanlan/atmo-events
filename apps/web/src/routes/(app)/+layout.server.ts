import type { LayoutServerLoad } from './$types';

// Groups live at a group host, so a deployment without one offers none.
export const load: LayoutServerLoad = async ({ platform }) => {
	return { groupsEnabled: Boolean(platform?.env.GROUP_HOST_URL?.trim()) };
};

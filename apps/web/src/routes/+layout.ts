import { configureAtproto } from '@atmo-dev/events-ui';
import { network } from '$lib/atproto/network';
import type { LayoutLoad } from './$types';

export const ssr = true;

// What this returns replaces +layout.server.ts's data, so it passes that data on.
export const load: LayoutLoad = ({ data }) => {
	const { imageUrlTemplate, appviewUrl } = network();
	configureAtproto({ imageUrlTemplate, appviewUrl });
	return data;
};

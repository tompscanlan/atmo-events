import { configureAtproto } from '@atmo-dev/events-ui';
import { network } from '$lib/atproto/network';

export const ssr = true;

export const load = () => {
	const { blobUrlTemplate, appviewUrl } = network();
	configureAtproto({ blobUrlTemplate, appviewUrl });
};

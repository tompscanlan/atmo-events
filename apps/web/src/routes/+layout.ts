import { configureAtproto } from '@atmo-dev/events-ui';
import { network } from '$lib/atproto/network';

export const ssr = true;

// The shared components read their image and Bluesky-API addresses from this
// deployment's network settings. Runs on the server before render and again in the
// browser, so both sides agree.
export const load = () => {
	const { blobUrlTemplate, appviewUrl } = network();
	configureAtproto({ blobUrlTemplate, appviewUrl });
};

// What `$app/environment` gives the app's server build, for the e2e's own Vite
// build, which runs without the SvelteKit plugin. The OAuth client the groups
// modules reach for a linked session reads `dev` (src/lib/atproto/server/oauth.ts).
export const dev = false;
export const browser = false;
export const building = false;
export const version = 'groups-e2e';

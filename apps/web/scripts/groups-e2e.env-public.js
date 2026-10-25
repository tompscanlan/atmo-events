// What `$env/dynamic/public` gives the app's server build, for the e2e's own Vite
// build, which runs without the SvelteKit plugin. No settings: the network
// addresses (src/lib/atproto/network.ts) keep their defaults, and the run's own
// replacements point the identity resolver at the devnet's PLC.
export const env = {};

// `types` in tsconfig.json is pinned to ["@cloudflare/workers-types", "node"],
// which deliberately leaves out `vite/client` — so Vite's own `*?raw` module
// declaration isn't in scope. The groups migration is imported that way
// ($lib/groups/server/schema.ts) to keep one copy of the DDL that is both
// bundled into the Worker and runnable by `wrangler d1 execute --file`.
declare module '*.sql?raw' {
	const content: string;
	export default content;
}

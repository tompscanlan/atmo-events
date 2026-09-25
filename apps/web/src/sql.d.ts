// tsconfig.json pins `types` to ["@cloudflare/workers-types", "node"], which
// leaves out `vite/client` and with it Vite's `*?raw` module declaration.
// $lib/groups/server/schema.ts imports the groups migrations with `?raw`, so one
// copy of the DDL is both bundled into the Worker and runnable with
// `wrangler d1 execute --file`.
declare module '*.sql?raw' {
	const content: string;
	export default content;
}

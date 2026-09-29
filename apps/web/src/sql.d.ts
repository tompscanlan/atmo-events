// tsconfig's `types` leaves out vite/client, so declare the `?raw` imports schema.ts uses.
declare module '*.sql?raw' {
	const content: string;
	export default content;
}

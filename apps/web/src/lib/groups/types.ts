// Shapes the pages and the server share, kept out of `server/` so a page imports no server code.

export interface RosterEntry {
	did: string;
	role: string;
	created_at: number;
	/** Whether the member wrote their acceptance; null when it was not read. Never changes access. */
	confirmed: boolean | null;
}

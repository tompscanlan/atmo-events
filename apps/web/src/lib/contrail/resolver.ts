import {
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver
} from '@atcute/identity-resolver';

/**
 * Build a DID document resolver that honors a custom PLC apiUrl.
 *
 * Server-only. The caller passes the url (e.g. from `$env/dynamic/private`
 * PLC_URL) so this module stays framework-agnostic and importable by both the
 * in-process app client and the standalone live-ingest process.
 *
 * Without `{ apiUrl }`, devnet `did:plc` resolves against the public
 * plc.directory and 404s — communities/users provisioned on devnet (whose
 * records live only in the local PLC) are never found. Mirrors the inline
 * construction in `community/server/resolve-space-host.ts` and `atproto/server/oauth.ts`.
 */
export function buildLocalResolver(plcUrl?: string) {
	return new CompositeDidDocumentResolver({
		methods: {
			plc: new PlcDidDocumentResolver(plcUrl ? { apiUrl: plcUrl } : undefined),
			web: new WebDidDocumentResolver()
		}
	});
}

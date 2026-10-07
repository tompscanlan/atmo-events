// Devnet mode: atmo against a local atproto devnet, signed in through atproto's loopback OAuth
// client. `vite dev --mode devnet` (pnpm dev:devnet) defines import.meta.env.DEVNET true, and
// every other build defines it false, so the branches in oauth.ts that call into this module are
// dropped from those builds, and this module with them. Nothing here runs on import. Those
// branches test `import.meta.env.DEVNET === true`, not the bare flag, because vitest hands a
// define to the code as a string, and the string 'false' is truthy.
import {
	CompositeDidDocumentResolver,
	LocalActorResolver,
	PlcDidDocumentResolver,
	XrpcHandleResolver
} from '@atcute/identity-resolver';
import type { OAuthClient } from '@atcute/oauth-node-client';

/** Where the devnet is: its PLC directory and the PDS that holds its accounts. */
export interface DevnetUrls {
	plcUrl: string;
	pdsUrl: string;
}

/** The devnet this build was made for. vite.config.ts takes both from the environment in
 *  devnet mode, with no default. */
export function urls(): DevnetUrls {
	return { plcUrl: import.meta.env.DEVNET_PLC_URL, pdsUrl: import.meta.env.DEVNET_PDS_URL };
}

/** The line a devnet server logs once at startup, so a run shows which devnet it talks to. */
export function logStartup({ plcUrl, pdsUrl }: DevnetUrls): void {
	console.info(
		`[oauth] atmo devnet build: identities from the devnet PLC ${plcUrl} and PDS ${pdsUrl} only, ` +
			'bindings and vars from devnet/wrangler.jsonc, sign-in through the loopback client over http'
	);
}

/** Resolves people on the devnet and nowhere else: a DID at the devnet's PLC directory, a
 *  handle through the devnet PDS's com.atproto.identity.resolveHandle. There is no DNS or
 *  well-known lookup, no did:web and no plc.directory fallback, so a handle or DID the devnet
 *  does not know is refused, and a devnet server never signs in a real-network account. */
export function actorResolver({ plcUrl, pdsUrl }: DevnetUrls): LocalActorResolver {
	return new LocalActorResolver({
		handleResolver: new XrpcHandleResolver({ serviceUrl: pdsUrl }),
		didDocumentResolver: new CompositeDidDocumentResolver({
			methods: { plc: new PlcDidDocumentResolver({ apiUrl: plcUrl }) }
		})
	});
}

const RESOLVER_FIELDS = ['protectedResourceResolver', 'authorizationServerResolver'] as const;

/** Lets an atcute OAuth client fetch the devnet PDS's OAuth metadata, which is served over
 *  http. atcute builds both of a client's metadata resolvers with allowHttp off and has no
 *  option to turn it on, so this sets the field on each. Both fields are atcute internals: if
 *  an upgrade renames either, this throws a DevnetResolverFieldsError and sets neither, rather
 *  than leave a client that fails later at sign-in. */
export function allowHttpOnResolvers(client: OAuthClient): OAuthClient {
	const resolver = (client as unknown as { resolver?: Record<string, unknown> }).resolver;
	const targets = RESOLVER_FIELDS.map((field) => {
		const target = resolver?.[field] as { allowHttp?: unknown } | undefined;
		if (typeof target?.allowHttp !== 'boolean') {
			const error = new Error(
				`the OAuth client has no resolver.${field}.allowHttp to set (has @atcute/oauth-node-client changed?)`
			);
			error.name = 'DevnetResolverFieldsError';
			throw error;
		}
		return target;
	});
	for (const target of targets) target.allowHttp = true;
	return client;
}

/** A devnet build allows http OAuth and trusts devnet identities only, so it must never run as
 *  a public site, which always has an https OAUTH_PUBLIC_URL. A devnet build that finds one
 *  refuses to build an OAuth client at all. */
export function refuseHttpsPublicUrl(publicUrl: string | undefined): void {
	if (publicUrl?.trim().toLowerCase().startsWith('https:')) {
		throw new Error(
			`a devnet build refuses OAUTH_PUBLIC_URL ${publicUrl}: an https site never runs devnet mode`
		);
	}
}

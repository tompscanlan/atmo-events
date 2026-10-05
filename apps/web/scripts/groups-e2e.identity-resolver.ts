// The e2e's stand-in for `@atcute/identity-resolver`, aliased over it in the
// Vite build (groups-e2e.mjs) only when E2E_PLC_URL is set.
//
// The app resolves did:plc at plc.directory, so a sandbox network with its own
// PLC directory (atproto-devnet) is invisible to it. Here every
// `PlcDidDocumentResolver` asks E2E_PLC_URL first and plc.directory for a DID
// the sandbox does not know, so the sandbox's group and people resolve, and so
// does a person on the real network. Everything else is the package's own.
//
// Imported by file path, which the alias does not match.
import {
	DocumentNotFoundError,
	PlcDidDocumentResolver as PackagePlcResolver,
	type PlcDidDocumentResolverOptions
} from '../node_modules/@atcute/identity-resolver/dist/index.js';

export * from '../node_modules/@atcute/identity-resolver/dist/index.js';

/** Set by the build's `define`. */
declare const __E2E_PLC_URL__: string;

export class PlcDidDocumentResolver extends PackagePlcResolver {
	readonly #network: PackagePlcResolver;

	constructor(options: PlcDidDocumentResolverOptions = {}) {
		super({ ...options, apiUrl: __E2E_PLC_URL__ });
		this.#network = new PackagePlcResolver(options);
	}

	override async resolve(...args: Parameters<PackagePlcResolver['resolve']>) {
		try {
			return await super.resolve(...args);
		} catch (e) {
			if (e instanceof DocumentNotFoundError) return this.#network.resolve(...args);
			throw e;
		}
	}
}

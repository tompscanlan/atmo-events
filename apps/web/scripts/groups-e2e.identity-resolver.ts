// The e2e's stand-in for `@atcute/identity-resolver`, aliased over it in the
// Vite build (groups-e2e.mjs) on every run.
//
// The app resolves did:plc at plc.directory, so a sandbox network with its own
// PLC directory (atproto-devnet) is invisible to it. Here every
// `PlcDidDocumentResolver` asks E2E_PLC_URL and nothing else: a DID the sandbox
// does not know fails to resolve, so a lookup never leaves this machine.
// Everything else is the package's own.
//
// Imported by file path, which the alias does not match.
import {
	PlcDidDocumentResolver as PackagePlcResolver,
	type PlcDidDocumentResolverOptions
} from '../node_modules/@atcute/identity-resolver/dist/index.js';

export * from '../node_modules/@atcute/identity-resolver/dist/index.js';

/** Set by the build's `define`. */
declare const __E2E_PLC_URL__: string;

export class PlcDidDocumentResolver extends PackagePlcResolver {
	constructor(options: PlcDidDocumentResolverOptions = {}) {
		super({ ...options, apiUrl: __E2E_PLC_URL__ });
	}
}

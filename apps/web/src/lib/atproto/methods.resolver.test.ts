import { describe, it, expect, vi } from 'vitest';

// Mirror resolver.test.ts / resolve-space-host.test.ts: mock the resolver
// classes so we assert the WIRING (does methods.ts thread PUBLIC_PLC_URL ->
// { apiUrl } so devnet did:plc resolves?) without a live PLC.
vi.mock('@atcute/identity-resolver', () => ({
	CompositeDidDocumentResolver: vi.fn(),
	PlcDidDocumentResolver: vi.fn(),
	WebDidDocumentResolver: vi.fn(),
	CompositeHandleResolver: vi.fn(),
	DohJsonHandleResolver: vi.fn(),
	WellKnownHandleResolver: vi.fn()
}));

// PUBLIC_PLC_URL is the load-bearing input: without it the DID resolver hits
// the public plc.directory and 404s on devnet community/user DIDs (which live
// only on our local PLC) — in the browser too, via the in-app editor.
vi.mock('$env/dynamic/public', () => ({
	env: { PUBLIC_PLC_URL: 'http://localhost:2582' }
}));

describe('methods.ts DID resolver', () => {
	it('points the plc resolver at PUBLIC_PLC_URL (devnet local PLC)', async () => {
		// Import after mocks so the module-level resolver is built against them.
		await import('./methods');
		const { PlcDidDocumentResolver } = await import('@atcute/identity-resolver');
		expect(PlcDidDocumentResolver).toHaveBeenCalledWith({ apiUrl: 'http://localhost:2582' });
	});
});

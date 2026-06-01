import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver
} from '@atcute/identity-resolver';

// Mirror resolve-space-host.test.ts: mock the resolver classes so we assert the
// wiring (does buildLocalResolver thread plcUrl -> { apiUrl }?) without a live PLC.
// Bare vi.fn()s are constructable with `new`; arrow implementations are not.
vi.mock('@atcute/identity-resolver', () => ({
	CompositeDidDocumentResolver: vi.fn(),
	PlcDidDocumentResolver: vi.fn(),
	WebDidDocumentResolver: vi.fn()
}));

import { buildLocalResolver } from './resolver';

describe('buildLocalResolver', () => {
	beforeEach(() => vi.clearAllMocks());

	it('points the plc resolver at the given apiUrl (devnet local PLC)', () => {
		buildLocalResolver('http://localhost:2582');
		// The load-bearing behavior: without { apiUrl } devnet did:plc resolves
		// against the public plc.directory and 404s.
		expect(PlcDidDocumentResolver).toHaveBeenCalledWith({ apiUrl: 'http://localhost:2582' });
		expect(WebDidDocumentResolver).toHaveBeenCalledTimes(1);
		expect(CompositeDidDocumentResolver).toHaveBeenCalledWith({
			methods: { plc: expect.anything(), web: expect.anything() }
		});
	});

	it('falls back to the default public PLC when no url is given', () => {
		buildLocalResolver();
		expect(PlcDidDocumentResolver).toHaveBeenCalledWith(undefined);
	});
});

import { describe, expect, it } from 'vitest';
import { load } from './+layout.server';

type LoadEvent = Parameters<typeof load>[0];
const run = (env: Partial<App.Platform['env']>) =>
	load({ platform: { env } } as unknown as LoadEvent) as Promise<{ groupsEnabled: boolean }>;

describe('app layout load', () => {
	it('offers groups when a group PDS is configured', async () => {
		expect(await run({ GROUP_PDS_SERVICE: 'https://pds.example.com' })).toEqual({
			groupsEnabled: true
		});
	});

	it('hides groups on a deployment with no group PDS', async () => {
		expect(await run({})).toEqual({ groupsEnabled: false });
		expect(await run({ GROUP_PDS_SERVICE: '  ' })).toEqual({ groupsEnabled: false });
	});
});

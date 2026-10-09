import { afterEach, describe, expect, it, vi } from 'vitest';

// The new-event page's loader. The group gate is stubbed at its module
// boundary: what is under test is the calendar space handed to the page, which
// follows from the DID the gate resolved, not from the URL, and costs no call.
vi.mock('$lib/groups/server/editor-page', () => ({ groupEditorPage: vi.fn() }));

import { load } from './+page.server';
import { groupEditorPage } from '$lib/groups/server/editor-page';
import type { CallerMembership, GroupRow } from '$lib/groups/types';

const OWNER = 'did:plc:owner';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const HANDLE = 'kona.groups.example.com';
const ENV = { DB: {} };

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(groupEditorPage).mockReset();
});

describe('/groups/[actor]/events/new load', () => {
	// The page sends who can see the event; the writer works out where it goes, so
	// the loader hands the page no space at all.
	it('the new-event page loader hands the page the group and a fresh key, and no space', async () => {
		vi.mocked(groupEditorPage).mockResolvedValue({
			group: { group_did: GROUP_DID } as GroupRow,
			membership: {} as CallerMembership,
			reader: null,
			groupDid: GROUP_DID,
			groupName: 'Kona',
			handle: HANDLE,
			canDelete: false
		});
		const fetching = vi.spyOn(globalThis, 'fetch');

		// Opened by handle, and the data names the group by its DID.
		const data = await load({
			params: { actor: HANDLE },
			locals: { did: OWNER },
			platform: { env: ENV }
		} as unknown as Parameters<typeof load>[0]);

		expect(data).toEqual({
			groupDid: GROUP_DID,
			groupName: 'Kona',
			handle: HANDLE,
			rkey: expect.stringMatching(/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/)
		});
		// Still behind the same gate, and nothing asked of a PDS.
		expect(vi.mocked(groupEditorPage).mock.calls).toEqual([[ENV, HANDLE, OWNER, 'CREATE_EVENT']]);
		expect(fetching).not.toHaveBeenCalled();
	});
});

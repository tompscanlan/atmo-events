import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import EventHostedBy from '@atmo-dev/events-ui/event-view/EventHostedBy.svelte';
import type { EventHost } from '@atmo-dev/events-ui';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const HOST_PROFILE = { did: GROUP_DID, handle: 'kona.group.stub.test' };

function hostLine(host?: EventHost | null): string {
	return render(EventHostedBy, {
		props: { hostProfile: HOST_PROFILE, hostUrl: '/p/kona.group.stub.test', did: GROUP_DID, host }
	}).body;
}

describe('the Hosted By line', () => {
	it("links the account's own page when the page names no host", () => {
		const body = hostLine();
		expect(body).toContain('href="/p/kona.group.stub.test"');
		expect(body).toContain('kona.group.stub.test');
	});

	it("names the group and links its page in place of the account's", () => {
		const body = hostLine({ name: 'Kona Paddlers', href: `/groups/${GROUP_DID}` });
		expect(body).toContain(`href="/groups/${GROUP_DID}"`);
		expect(body).toContain('Kona Paddlers');
		expect(body).not.toContain('/p/kona.group.stub.test');
	});

	it('shows a host with no href, and its note, without any link', () => {
		const body = hostLine({ name: 'kona.group.stub.test', href: null, note: 'Private group' });
		expect(body).not.toContain('<a');
		expect(body).toContain('kona.group.stub.test');
		expect(body).toContain('Private group');
	});
});

import { error, fail, redirect } from '@sveltejs/kit';
import { groupAccess } from '#lib/groups/permissions-asked.js';
import { holdsCreateGroup } from '#lib/groups/scopes.js';
import {
	createGroupAtHost,
	GroupNotCreated,
	parseNewGroup,
	rememberUnfinished,
	unfinishedGroups,
	type NotCreatedReason
} from '#lib/groups/server/create.js';
import { requireGroupsEnabled } from '#lib/groups/server/enabled.js';
import { forgetHeldAtGroupHost } from '#lib/groups/server/group.js';
import { groupHostInfo } from '#lib/groups/server/host-api.js';
import { groupSignInAvailable, startGroupLink } from '#lib/groups/server/sign-in.js';
import { callerSession } from '#lib/private-events/server/caller.js';

/** What the form says when the group was not made, by why. */
const NOT_CREATED: Record<NotCreatedReason | 'form', string> = {
	form: 'Check the form: a name is needed, up to 64 characters, and an address of letters, digits and inner hyphens.',
	'not-allowed':
		"This group host makes groups only for the people it names, and you aren't one of them. Ask the people who run it.",
	'address-taken': 'That address is taken. Try another.',
	'address-invalid': 'The group host does not take that address. Try another.',
	invalid: 'The group host did not take these details. Check them and try again.',
	'no-permission':
		'Your server did not vouch for you to the group host. Allow making groups first.',
	unavailable: 'The group host could not be reached. Try again shortly.'
};

export async function load({ locals, url, setHeaders }) {
	requireGroupsEnabled();
	if (!locals.did) redirect(303, '/login');
	setHeaders({ 'cache-control': 'no-store' });
	if (!groupSignInAvailable()) {
		return { pageTitle: 'Make a group', available: false as const };
	}
	const [host, caller, unfinished] = await Promise.all([
		groupHostInfo().catch((e) => {
			console.error('[groups] the group host did not describe itself:', e);
			return null;
		}),
		callerSession(locals.session ?? null),
		unfinishedGroups(locals.did)
	]);
	return {
		pageTitle: 'Make a group',
		available: true as const,
		did: locals.did,
		host: host ? { domain: host.domain, newGroupUrl: host.newGroupUrl } : null,
		access: caller && !holdsCreateGroup(caller.scope) ? groupAccess(url, caller.did) : null,
		unfinished: unfinished.map(({ did, handle }) => ({ did, handle }))
	};
}

export const actions = {
	default: async ({ request, locals }) => {
		requireGroupsEnabled();
		if (!groupSignInAvailable()) error(404, 'Not Found');
		if (!locals.did) redirect(303, '/login');

		const form = await request.formData();
		const values = {
			name: String(form.get('name') ?? ''),
			address: String(form.get('address') ?? ''),
			description: String(form.get('description') ?? ''),
			joinPolicy: String(form.get('joinPolicy') ?? ''),
			public: form.get('visibility') === 'public',
			listed: form.get('listed') === 'on'
		};
		const refused = (status: number, reason: keyof typeof NOT_CREATED) =>
			fail(status, { values, reason, message: NOT_CREATED[reason] });

		const group = parseNewGroup(values);
		if (!group) return refused(400, 'form');
		const caller = await callerSession(locals.session ?? null);
		if (!caller) redirect(303, '/login');
		if (!holdsCreateGroup(caller.scope)) return refused(403, 'no-permission');
		const host = await groupHostInfo().catch(() => null);
		if (!host) return refused(503, 'unavailable');

		let made: { did: string; handle: string };
		try {
			made = await createGroupAtHost(caller, group, host);
		} catch (e) {
			if (e instanceof GroupNotCreated) {
				return refused(
					e.reason === 'not-allowed' ? 403 : e.reason === 'unavailable' ? 502 : 400,
					e.reason
				);
			}
			throw e;
		}
		// Noted before the link starts, so a link that does not finish leaves a way back to it.
		await rememberUnfinished(locals.did, {
			...made,
			public: group.public,
			listed: group.listed
		});
		await forgetHeldAtGroupHost();

		let to: URL;
		try {
			to = await startGroupLink(made.did, locals.did);
		} catch (e) {
			// This page lists it, to link from.
			console.error(`[groups] starting the link to ${made.did}, just made, failed:`, e);
			redirect(303, '/groups/create');
		}
		// The OAuth client built it from the new group's authorization server, not from input.
		redirect(303, to.toString(), { external: true });
	}
};

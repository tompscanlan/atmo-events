<script lang="ts">
	import { Button } from '@atmo-dev/kit';
	import { requestPermissions } from '@svelte-atproto/oauth/client';
	import { PARTICIPATE_SCOPES } from '../scopes';
	import { askedReturnTo, type GroupAccess } from '../permissions-asked';

	// Shaped on private events' notice (PrivateEventAccessNotice.svelte), for what a person's own
	// sign-in needs for groups: joining groups, and reading those they are in, with their own access.
	let {
		access,
		did,
		purpose = null,
		spacesServer = null
	}: {
		access: GroupAccess;
		/** The signed-in person's DID, in the address the ask comes back to. */
		did: string;
		/** What granting it lets the person do on this page. */
		purpose?: string | null;
		/** A PDS with spaces support to point at when their server says no. */
		spacesServer?: { url: string; host: string } | null;
	} = $props();

	let busy = $state(false);
	let failure: string | null = $state(null);

	async function ask() {
		busy = true;
		failure = null;
		try {
			const back = location.pathname + location.search;
			await requestPermissions([...PARTICIPATE_SCOPES], { returnTo: askedReturnTo(back, did) });
		} catch {
			failure = 'That did not work. Try again.';
		} finally {
			busy = false;
		}
	}
</script>

<div
	class="rounded-ui border-base-200 dark:border-base-800 mt-4 border p-4"
	data-testid="grant-notice"
>
	{#if failure}<p role="alert" class="text-base-950 dark:text-base-50 mb-2 text-sm">
			{failure}
		</p>{/if}
	{#if access === 'ask'}
		<p class="text-base-700 dark:text-base-300 text-sm">
			{purpose ??
				'To join groups and see the ones you are in, atmo asks your server to act for you in groups.'}
			Your server asks you first.
		</p>
		<Button class="mt-3" disabled={busy} onclick={ask}>Allow joining groups</Button>
	{:else}
		<p class="text-base-700 dark:text-base-300 text-sm" role="status">
			Your server did not give atmo permission to act for you in groups. Most servers can't yet: it
			takes spaces support, the part of atproto that keeps a group's members, and a private group,
			private. Without it you can't join a group here, or confirm you are in one.
		</p>
		{#if spacesServer}<p class="text-base-600 dark:text-base-400 mt-2 text-sm">
				You can make an account at
				<!-- Another site's address, from this site's settings, so there is nothing to resolve. -->
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a
					href={spacesServer.url}
					rel="external noopener"
					class="text-accent-600 dark:text-accent-400 hover:underline">{spacesServer.host}</a
				><!-- eslint-enable svelte/no-navigation-without-resolve -->, which can, and sign in to atmo
				with it.
			</p>{/if}
		<Button class="mt-3" size="sm" variant="ghost" disabled={busy} onclick={ask}>Try again</Button>
	{/if}
</div>

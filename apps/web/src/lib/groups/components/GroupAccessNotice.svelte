<script lang="ts">
	import { Button } from '@atmo-dev/kit';
	import { requestPermissions } from '@svelte-atproto/oauth/client';
	import { CREATE_GROUP_SCOPE } from '../scopes';
	import { askedReturnTo, type GroupAccess } from '../permissions-asked';

	// Shaped on private events' notice (PrivateEventAccessNotice.svelte), for the one permission a
	// person's own sign-in needs for groups: to make one.
	let {
		access,
		did,
		newGroupUrl = null
	}: {
		access: GroupAccess;
		/** The signed-in person's DID, in the address the ask comes back to. */
		did: string;
		/** The group host's own page for making a group, offered when their server says no. */
		newGroupUrl?: string | null;
	} = $props();

	let busy = $state(false);
	let failure: string | null = $state(null);

	async function ask() {
		busy = true;
		failure = null;
		try {
			const back = location.pathname + location.search;
			await requestPermissions([CREATE_GROUP_SCOPE], { returnTo: askedReturnTo(back, did) });
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
			To make a group, atmo asks your server to vouch for you to the group host, which makes it.
			Your server asks you first.
		</p>
		<Button class="mt-3" disabled={busy} onclick={ask}>Allow making groups</Button>
	{:else}
		<p class="text-base-700 dark:text-base-300 text-sm" role="status">
			Your server did not give atmo permission to make groups for you.
		</p>
		{#if newGroupUrl}<p class="text-base-600 dark:text-base-400 mt-2 text-sm">
				You can make one on the group host's own page instead, then link it here.
				<!-- The group host's address, from this site's settings, so there is nothing to resolve. -->
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a
					href={newGroupUrl}
					rel="external noopener"
					class="text-accent-600 dark:text-accent-400 hover:underline">Make a group there</a
				><!-- eslint-enable svelte/no-navigation-without-resolve -->
			</p>{/if}
		<Button class="mt-3" size="sm" variant="ghost" disabled={busy} onclick={ask}>Try again</Button>
	{/if}
</div>

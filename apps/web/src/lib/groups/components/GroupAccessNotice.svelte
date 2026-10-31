<script lang="ts">
	import { Button } from '@atmo-dev/kit';
	import { requestPermissions } from '@svelte-atproto/oauth/client';
	import { markAsked, type GroupAccess } from '../permissions-asked';
	import { GROUP_PERSON_SCOPES } from '../scopes';

	let {
		access,
		did,
		purpose,
		spacesServer,
		explain = false
	}: {
		access: Exclude<GroupAccess, null>;
		/** The signed-in person's DID, remembered with the ask. */
		did: string;
		/** What granting them lets the person see on this page. */
		purpose: string;
		spacesServer: { url: string; host: string } | null;
		/** Say what it takes before the person has asked, too. */
		explain?: boolean;
	} = $props();

	let busy = $state(false);
	let failure: string | null = $state(null);

	async function ask() {
		busy = true;
		failure = null;
		try {
			markAsked(did);
			await requestPermissions(GROUP_PERSON_SCOPES);
		} catch {
			failure = 'That did not work. Try again.';
		} finally {
			busy = false;
		}
	}
</script>

{#snippet pointer()}
	{#if spacesServer}
		You can make an account at
		<!-- Another site's address, from this site's settings, so there is nothing to resolve. -->
		<!-- eslint-disable svelte/no-navigation-without-resolve -->
		<a
			href={spacesServer.url}
			rel="external noopener"
			class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 font-medium"
			>{spacesServer.host}</a
		><!-- eslint-enable svelte/no-navigation-without-resolve -->, which has it, and sign in to atmo
		with it.
	{/if}
{/snippet}

{#if failure}<p role="alert" class="mt-4 text-sm text-red-600">{failure}</p>{/if}
{#if access === 'ask'}
	<div class="mt-6 flex flex-wrap items-center gap-3">
		<Button variant="secondary" disabled={busy} onclick={ask}>See your groups</Button>
		<span class="text-muted text-sm">{purpose}</span>
	</div>
	{#if explain}
		<p class="text-muted mt-4 text-sm">
			This needs a server with spaces support, the part of atproto that keeps a group's members
			private, and most servers do not have it yet.
			{@render pointer()}
		</p>
	{/if}
{:else}
	<div class="mt-6 text-sm" role="status">
		<p class="text-base-700 dark:text-base-300">
			Your server did not give atmo group permissions. Most servers cannot yet: it takes spaces
			support, the part of atproto that keeps a group's members and members-only events private.
		</p>
		{#if spacesServer}<p class="text-muted mt-2">{@render pointer()}</p>{/if}
		<Button class="mt-2" size="sm" variant="ghost" disabled={busy} onclick={ask}>Try again</Button>
	</div>
{/if}

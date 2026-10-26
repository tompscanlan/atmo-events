<script lang="ts">
	import { Button } from '@foxui/core';
	import { reauthorize } from '$lib/atproto/auth.svelte';
	import { signInForGroup } from '$lib/groups/roster.remote';

	// For a member whose sign-in cannot read the group's spaces, or cannot write their
	// acceptance (`confirm`): a new sign-in asks for the groups permission set, writes the
	// acceptance, and comes back to this page.
	let {
		groupDid,
		subject = 'members',
		class: className
	}: {
		groupDid: string;
		subject?: 'members' | 'group' | 'confirm';
		class?: string;
	} = $props();

	let busy = $state(false);
	let failed = $state(false);

	async function signIn() {
		busy = true;
		failed = false;
		try {
			reauthorize(await signInForGroup({ groupDid }));
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}
</script>

<div class={className}>
	{#if subject === 'confirm'}
		<p class="text-base-600 dark:text-base-300 text-sm">
			You're a member, but you haven't confirmed it from your account yet, so the group's roster
			leaves you out. Confirming signs you in again.
		</p>
		<Button class="mt-3" variant="secondary" onclick={signIn} disabled={busy}>Confirm</Button>
	{:else}
		<p class="text-base-600 dark:text-base-300 text-sm">
			You'll see {subject === 'group' ? 'this group' : "this group's members"} after you sign in again.
			Your current sign-in doesn't include groups.
		</p>
		<Button class="mt-3" variant="secondary" onclick={signIn} disabled={busy}>Sign in again</Button>
	{/if}
	{#if failed}
		<p class="mt-2 text-sm text-red-600 dark:text-red-400">
			The sign-in couldn't be started. Try again in a few minutes.
		</p>
	{/if}
</div>

<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '@foxui/core';
	import { reauthorize } from '$lib/atproto/auth.svelte';
	import { signInForGroup } from '$lib/groups/roster.remote';

	// For a member whose sign-in carries no grant for this group, such as its
	// creator right after the create: the members stay hidden until a new
	// sign-in, which the button starts and which comes back to this page. `from`
	// is when a new sign-in can carry the grant, or null when one already can
	// (CallerMembership's `signIn`). `subject` is what the sign-in opens: the
	// members, or the whole group when it is hidden from the caller until then.
	let {
		groupDid,
		from,
		subject = 'members',
		class: className
	}: {
		groupDid: string;
		from: number | null;
		subject?: 'members' | 'group';
		class?: string;
	} = $props();

	// In the viewer's own time zone, so only once the page runs in the browser:
	// the server knows none. Until then the sentence names no time.
	let mounted = $state(false);
	onMount(() => (mounted = true));
	let fromTime = $derived(
		mounted && from !== null
			? new Date(from).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
			: null
	);

	let busy = $state(false);
	/** Why the last press did not leave the page: the PDS refused the grant, as
	 *  it does until its copy of this site's client metadata names the group, or
	 *  the request failed. */
	let failed = $state<'refused' | 'error' | null>(null);

	async function signIn() {
		busy = true;
		failed = null;
		try {
			const url = await signInForGroup({ groupDid });
			if (url) return reauthorize(url);
			failed = 'refused';
		} catch {
			failed = 'error';
		} finally {
			busy = false;
		}
	}
</script>

<div class={className}>
	<p class="text-base-600 dark:text-base-300 text-sm">
		You'll see {subject === 'group' ? 'this group' : "this group's members"} after you sign in again{#if fromTime},
			from
			<time datetime={new Date(from!).toISOString()}>{fromTime}</time>{/if}. Your current sign-in
		doesn't include this group.
	</p>
	<Button class="mt-3" variant="secondary" onclick={signIn} disabled={busy}>Sign in again</Button>
	{#if failed}
		<p class="mt-2 text-sm text-red-600 dark:text-red-400">
			{failed === 'refused'
				? "Your account's server doesn't know about this group yet."
				: "The sign-in couldn't be started."}
			{fromTime ? `Try again from ${fromTime}.` : 'Try again in a few minutes.'}
		</p>
	{/if}
</div>

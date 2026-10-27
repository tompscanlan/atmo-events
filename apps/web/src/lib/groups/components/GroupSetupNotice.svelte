<script lang="ts">
	import { Button } from '@foxui/core';
	import { invalidateAll } from '$app/navigation';
	import { finishGroupSetupCommand } from '$lib/groups/group.remote';

	let {
		groupDid,
		error = null,
		class: className
	}: { groupDid: string; error?: string | null; class?: string } = $props();

	let busy = $state(false);
	let failure = $state<string | null>(null);
	let shown = $derived(failure ?? error);

	async function finish() {
		busy = true;
		failure = null;
		try {
			const result = await finishGroupSetupCommand({ groupDid });
			if (result.ok) await invalidateAll();
			else failure = result.error;
		} catch {
			failure = 'Setting it up could not be finished. Try again in a few minutes.';
		} finally {
			busy = false;
		}
	}
</script>

<div class={className}>
	<p class="text-base-600 dark:text-base-300 text-sm">
		The group host made this group, but setting it up here did not finish. Only you can see it until
		it does.
	</p>
	<Button class="mt-3" onclick={finish} disabled={busy}>Finish setting up</Button>
	{#if shown}
		<p class="mt-2 text-sm text-red-600 dark:text-red-400">{shown}</p>
	{/if}
</div>

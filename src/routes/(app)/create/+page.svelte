<script lang="ts">
	import EventEditor from '$lib/components/EventEditor.svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';

	let { data } = $props();
	let privateMode = $derived(page.url.searchParams.get('private') === '1');

	function toggle() {
		const u = new URL(page.url);
		if (privateMode) u.searchParams.delete('private');
		else u.searchParams.set('private', '1');
		goto(u.pathname + u.search, { replaceState: true });
	}
</script>

<svelte:head>
	<title>{privateMode ? 'Create Private Event' : 'Create Event'}</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 pt-4">
	<label class="flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-base-300 bg-base-50 p-3 text-sm dark:border-base-700 dark:bg-base-900">
		<input type="checkbox" checked={privateMode} onchange={toggle} class="size-4" />
		<div>
			<div class="font-medium">Private event</div>
			<div class="text-xs text-base-500 dark:text-base-400">
				Only people you add (or who redeem an invite link) can see the event. Not published to your public profile.
			</div>
		</div>
	</label>
</div>

<EventEditor eventData={null} actorDid={data.actorDid} rkey={data.rkey} {privateMode} />

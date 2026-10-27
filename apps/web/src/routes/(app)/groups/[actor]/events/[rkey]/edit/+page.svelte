<script lang="ts">
	import { EventEditor } from '@atmo-dev/events-ui';
	import { user } from '$lib/atproto/auth.svelte';
	import { createGroupEditorAdapter } from '$lib/groups/editor-adapter';

	let { data } = $props();

	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		did: data.groupDid,
		handle: data.handle ?? undefined,
		displayName: data.groupName
	});
	let refusal = $state<string>();
	let adapter = $derived(
		createGroupEditorAdapter({
			groupDid: data.groupDid,
			editingRkey: data.rkey,
			canDelete: data.canDelete,
			onRefusal: (message) => (refusal = message)
		})
	);
</script>

<svelte:head>
	<title>Edit event - {data.groupName}</title>
</svelte:head>

{#if refusal}
	<div class="mx-auto max-w-3xl px-6 pt-8 sm:pt-12">
		<p class="text-sm text-red-600 dark:text-red-400" role="alert">{refusal}</p>
	</div>
{/if}

<div onsubmit={() => (refusal = undefined)}>
	<EventEditor
		eventData={data.eventData}
		actorDid={data.groupDid}
		rkey={data.rkey}
		{adapter}
		{viewer}
	/>
</div>

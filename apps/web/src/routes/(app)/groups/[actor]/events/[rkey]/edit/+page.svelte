<script lang="ts">
	import { EventEditor } from '@atmo-dev/events-ui';
	import { user } from '$lib/atproto/auth.svelte';
	import { createGroupEditorAdapter } from '$lib/groups/editor-adapter';

	let { data } = $props();

	// The group is the viewer, as on the new-event page.
	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		did: data.groupDid,
		handle: data.handle ?? undefined,
		displayName: data.groupName
	});
	// The server's own words when it refuses a save, a delete or an upload, as
	// on the new-event page.
	let refusal = $state<string>();
	// Public: the loader finds the event in the index, which holds public events
	// only.
	let adapter = $derived(
		createGroupEditorAdapter({
			groupDid: data.groupDid,
			editingRkey: data.rkey,
			canDelete: data.canDelete,
			space: null,
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

<EventEditor
	eventData={data.eventData}
	actorDid={data.groupDid}
	rkey={data.rkey}
	{adapter}
	{viewer}
/>

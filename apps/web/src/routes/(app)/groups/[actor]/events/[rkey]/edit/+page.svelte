<script lang="ts">
	import { EventEditor } from '@atmo-dev/events-ui';
	import { user } from '$lib/atproto/auth.svelte';
	import { createGroupEditorAdapter } from '$lib/groups/editor-adapter';
	import { PLACEMENT_FIXED, PLACEMENT_QUESTION, placementLabel } from '$lib/groups/event-placement';

	let { data } = $props();

	// The group is the viewer, as on the new-event page.
	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		did: data.groupDid,
		handle: data.handle ?? undefined,
		displayName: data.groupName
	});
	// Public: the loader finds the event in the index, which holds public events
	// only. The adapter and the line above the editor both read this one value.
	const space: string | null = null;
	// The server's own words when it refuses a save, a delete or an upload, as
	// on the new-event page.
	let refusal = $state<string>();
	let adapter = $derived(
		createGroupEditorAdapter({
			groupDid: data.groupDid,
			editingRkey: data.rkey,
			canDelete: data.canDelete,
			space,
			onRefusal: (message) => (refusal = message)
		})
	);
</script>

<svelte:head>
	<title>Edit event - {data.groupName}</title>
</svelte:head>

<!-- Shown, not offered: the writer refuses to move an event between the group's
     repo and its calendar space. (Spec: FR-107.) -->
<div class="mx-auto max-w-3xl px-6 pt-8 sm:pt-12">
	<p class="text-sm">
		{PLACEMENT_QUESTION}: <span class="font-semibold">{placementLabel(space)}</span>
	</p>
	<p class="text-base-500 dark:text-base-400 text-xs">{PLACEMENT_FIXED}</p>
	{#if refusal}
		<p class="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">{refusal}</p>
	{/if}
</div>

<EventEditor
	eventData={data.eventData}
	actorDid={data.groupDid}
	rkey={data.rkey}
	{adapter}
	{viewer}
/>

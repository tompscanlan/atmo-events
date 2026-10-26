<script lang="ts">
	import { EventEditor } from '@atmo-dev/events-ui';
	import { user } from '$lib/atproto/auth.svelte';
	import { createGroupEditorAdapter } from '$lib/groups/editor-adapter';
	import {
		PLACEMENT_FIXED,
		PLACEMENT_QUESTION,
		placementLabel,
		placementOf
	} from '$lib/groups/event-placement';

	let { data } = $props();

	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		did: data.groupDid,
		handle: data.handle ?? undefined,
		displayName: data.groupName
	});
	// A members-only event's image would preview from the public CDN, which would learn the
	// group's DID; it gets no preview, and the save still keeps the image.
	let storedImageUrl = $derived(data.space ? () => null : undefined);
	let refusal = $state<string>();
	let adapter = $derived(
		createGroupEditorAdapter({
			groupDid: data.groupDid,
			editingRkey: data.rkey,
			canDelete: data.canDelete,
			placement: placementOf(data.space),
			onRefusal: (message) => (refusal = message)
		})
	);
</script>

<svelte:head>
	<title>Edit event - {data.groupName}</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-6 pt-8 sm:pt-12">
	<p class="text-sm">
		<span class="font-semibold">{PLACEMENT_QUESTION}:</span>
		{placementLabel(data.space)}
	</p>
	<p class="text-base-500 dark:text-base-400 text-xs">{PLACEMENT_FIXED}</p>
	{#if refusal}
		<p class="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">{refusal}</p>
	{/if}
</div>

<div onsubmit={() => (refusal = undefined)}>
	<EventEditor
		eventData={data.eventData}
		actorDid={data.groupDid}
		rkey={data.rkey}
		{adapter}
		{viewer}
		{storedImageUrl}
	/>
</div>

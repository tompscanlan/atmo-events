<script lang="ts">
	import { EventEditor } from '@atmo-dev/events-ui';
	import { user } from '$lib/atproto/auth.svelte';
	import { createGroupEditorAdapter } from '$lib/groups/editor-adapter';
	import {
		PLACEMENT_OPTIONS,
		PLACEMENT_QUESTION,
		placementSpace,
		type EventPlacement
	} from '$lib/groups/event-placement';

	let { data } = $props();

	// The group is the viewer: the editor shows it as the host, and every save
	// lands in its repo or its calendar space.
	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		did: data.groupDid,
		handle: data.handle ?? undefined,
		displayName: data.groupName
	});
	// Unset until the person picks one: nothing is chosen for them, because a
	// public post can't be taken back. (Spec: FR-116.)
	let choice = $state<EventPlacement>();
	// The server's own words when it refuses a save, a delete or an upload. The
	// editor shows only its generic line, from the shared package.
	let refusal = $state<string>();
	// Rebuilt from the answer on screen, which the editor reads at each save, so
	// switching the answer changes where the next save goes and keeps the form.
	// No answer, no adapter, and so no editor.
	let adapter = $derived(
		choice
			? createGroupEditorAdapter({
					groupDid: data.groupDid,
					editingRkey: null,
					canDelete: false,
					space: placementSpace(choice, data.calendarSpaceUri),
					onRefusal: (message) => (refusal = message)
				})
			: undefined
	);
</script>

<svelte:head>
	<title>New event for {data.groupName}</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-6 pt-8 sm:pt-12">
	<fieldset>
		<legend class="mb-3 font-semibold">{PLACEMENT_QUESTION}</legend>
		<div class="flex flex-col gap-3">
			{#each PLACEMENT_OPTIONS as option (option.value)}
				<label class="flex items-start gap-2 text-sm">
					<input
						type="radio"
						name="placement"
						value={option.value}
						bind:group={choice}
						onchange={() => (refusal = undefined)}
						class="mt-0.5 size-4"
					/>
					<span>
						<span class="font-medium">{option.label}</span>
						<span class="text-base-500 dark:text-base-400 block text-xs">{option.help}</span>
					</span>
				</label>
			{/each}
		</div>
	</fieldset>
	{#if refusal}
		<p class="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">{refusal}</p>
	{/if}
</div>

{#if adapter}
	<EventEditor eventData={null} actorDid={data.groupDid} rkey={data.rkey} {adapter} {viewer} />
{/if}

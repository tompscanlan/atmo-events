<script lang="ts">
	import { EventEditor } from '@atmo-dev/events-ui';
	import { user } from '$lib/atproto/auth.svelte';
	import { createGroupEditorAdapter } from '$lib/groups/editor-adapter';
	import {
		PLACEMENT_OPTIONS,
		PLACEMENT_QUESTION,
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
	// The answer is locked from Publish until the save is over, so a save is
	// written where it was pressed. The editor reads its adapter only at the
	// write, after rendering and uploading the image, and a switch in between
	// would send the other answer. Its form's submit bubbles to the wrapper
	// below before its first adapter call, and the adapter says when the save is
	// over. A save that fails before any adapter call (the image render, say)
	// leaves the answer locked until the next Publish or a reload. After a save
	// that was written it stays locked, since the page is leaving for the events
	// tab.
	let saving = $state(false);
	function startSave() {
		saving = true;
		refusal = undefined;
	}
	// Rebuilt from the answer on screen, which the editor reads at each save, so
	// switching the answer changes where the next save goes and keeps the form.
	// No answer, no adapter, and so no editor.
	let adapter = $derived(
		choice
			? createGroupEditorAdapter({
					groupDid: data.groupDid,
					editingRkey: null,
					canDelete: false,
					placement: choice,
					onRefusal: (message) => (refusal = message),
					onSaveEnd: (saved) => {
						if (!saved) saving = false;
					}
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
				<div class="flex items-start gap-2 text-sm">
					<input
						id="placement-{option.value}"
						type="radio"
						name="placement"
						value={option.value}
						bind:group={choice}
						disabled={saving}
						aria-describedby="placement-{option.value}-help"
						onchange={() => (refusal = undefined)}
						class="mt-0.5 size-4"
					/>
					<div>
						<label for="placement-{option.value}" class="font-medium">{option.label}</label>
						<p id="placement-{option.value}-help" class="text-base-500 dark:text-base-400 text-xs">
							{option.help}
						</p>
					</div>
				</div>
			{/each}
		</div>
	</fieldset>
	{#if refusal}
		<p class="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">{refusal}</p>
	{/if}
</div>

{#if adapter}
	<div onsubmit={startSave}>
		<EventEditor eventData={null} actorDid={data.groupDid} rkey={data.rkey} {adapter} {viewer} />
	</div>
{/if}

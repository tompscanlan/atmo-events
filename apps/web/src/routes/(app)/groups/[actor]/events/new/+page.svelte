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

	// The group is the viewer, so the editor shows it as the host.
	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		did: data.groupDid,
		handle: data.handle ?? undefined,
		displayName: data.groupName
	});
	// Unset until picked: a public post can't be taken back.
	let choice = $state<EventPlacement>();
	let refusal = $state<string>();
	// Locked from Publish until the save is over: the editor reads its adapter only at the write,
	// so a switch in between would send the other answer.
	let saving = $state(false);
	function startSave() {
		saving = true;
		refusal = undefined;
	}
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

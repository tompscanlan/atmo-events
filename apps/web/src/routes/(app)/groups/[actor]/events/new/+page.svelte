<script lang="ts">
	import { EventEditor } from '@atmo-dev/kit/events';
	import { createGroupAdapter, groupViewer } from '#lib/groups/editor-adapter.js';
	import { PLACEMENT_OPTIONS, type EventPlacement } from '#lib/groups/event-placement.js';

	let { data } = $props();

	// No default: a public post can't be taken back.
	let placement: EventPlacement | null = $state(null);
	let viewer = $derived(groupViewer(data.group));
	let refused: string | null = $state(null);
	let adapter = $derived(
		placement
			? createGroupAdapter(
					data.group.did,
					viewer,
					(reason) => {
						refused = reason;
					},
					placement
				)
			: null
	);

	function unavailable(value: EventPlacement): string | null {
		if (value === 'members') return data.membersOnlyUnavailable;
		return data.postsPublic ? null : "Your role in this group doesn't let you post public events.";
	}
</script>

<div class="mx-auto max-w-2xl px-6 pt-12">
	<p class="text-base-600 dark:text-base-400 text-sm">
		Posted as {data.group.name}, from its page.
	</p>
	<fieldset class="mt-4">
		<legend class="text-base-900 dark:text-base-50 text-lg font-semibold">
			Who can see this event?
		</legend>
		{#each PLACEMENT_OPTIONS as option (option.value)}
			{@const why = unavailable(option.value)}
			<label class="mt-3 flex items-start gap-3">
				<input
					type="radio"
					name="placement"
					class="mt-1"
					value={option.value}
					disabled={why !== null}
					bind:group={placement}
				/>
				<span>
					<span class="text-base-900 dark:text-base-50 font-medium">{option.label}</span>
					<span class="text-base-600 dark:text-base-400 block text-sm">{why ?? option.help}</span>
				</span>
			</label>
		{/each}
	</fieldset>
	{#if refused}<p role="alert" class="text-base-950 dark:text-base-50 mt-4 text-sm">
			{refused}
		</p>{/if}
</div>

{#if adapter}
	{#key placement}
		<EventEditor eventData={null} actorDid={data.group.did} rkey={data.rkey} {adapter} {viewer} />
	{/key}
{/if}

<script lang="ts">
	import { EventEditor } from '@atmo-dev/events-ui';
	import { createGroupAdapter, groupViewer } from '#lib/groups/editor-adapter.js';
	import { PLACEMENT_OPTIONS, type EventPlacement } from '#lib/groups/event-placement.js';

	let { data } = $props();

	// No default: a public post can't be taken back.
	let placement: EventPlacement | null = $state(null);
	let viewer = $derived(groupViewer(data.group));
	let adapter = $derived(placement ? createGroupAdapter(data.group.did, viewer, placement) : null);
</script>

<div class="mx-auto max-w-2xl px-6 pt-12">
	<fieldset>
		<legend class="text-base-900 dark:text-base-50 text-lg font-semibold">
			Who can see this event?
		</legend>
		{#each PLACEMENT_OPTIONS as option (option.value)}
			{@const unavailable = option.value === 'members' ? data.membersOnlyUnavailable : null}
			<label class="mt-3 flex items-start gap-3">
				<input
					type="radio"
					name="placement"
					class="mt-1"
					value={option.value}
					disabled={unavailable !== null}
					bind:group={placement}
				/>
				<span>
					<span class="font-medium">{option.label}</span>
					<span class="text-muted block text-sm">{unavailable ?? option.help}</span>
				</span>
			</label>
		{/each}
	</fieldset>
</div>

{#if adapter}
	<EventEditor eventData={null} actorDid={data.group.did} rkey={data.rkey} {adapter} {viewer} />
{/if}

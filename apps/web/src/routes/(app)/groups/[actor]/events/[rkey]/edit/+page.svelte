<script lang="ts">
	import { EventEditor } from '@atmo-dev/kit/events';
	import { createGroupAdapter, groupViewer } from '#lib/groups/editor-adapter.js';

	let { data } = $props();

	let viewer = $derived(groupViewer(data.group));
	let refused: string | null = $state(null);
	let adapter = $derived(
		createGroupAdapter(data.group.did, viewer, (reason) => {
			refused = reason;
		})
	);
</script>

{#if refused}<p
		role="alert"
		class="text-base-950 dark:text-base-50 mx-auto max-w-2xl px-6 pt-6 text-sm"
	>
		{refused}
	</p>{/if}

<EventEditor
	eventData={data.eventData}
	actorDid={data.group.did}
	rkey={data.rkey}
	{adapter}
	{viewer}
/>

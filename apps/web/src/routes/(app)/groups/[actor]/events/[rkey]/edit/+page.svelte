<script lang="ts">
	import { EventEditor } from '@atmo-dev/events-ui';
	import { createGroupAdapter, groupViewer } from '#lib/groups/editor-adapter.js';
	import { PLACEMENT_OPTIONS } from '#lib/groups/event-placement.js';

	let { data } = $props();

	let viewer = $derived(groupViewer(data.group));
	let adapter = $derived(createGroupAdapter(data.group.did, viewer, data.placement));
	let shown = $derived(PLACEMENT_OPTIONS.find((option) => option.value === data.placement));
</script>

<p class="text-muted mx-auto max-w-2xl px-6 pt-12 text-sm">
	Who can see it: <span class="text-base-900 dark:text-base-50 font-medium">{shown?.label}</span>.
	This can't be changed after the event is published.
</p>

<EventEditor
	eventData={data.eventData}
	actorDid={data.group.did}
	rkey={data.rkey}
	{adapter}
	{viewer}
/>

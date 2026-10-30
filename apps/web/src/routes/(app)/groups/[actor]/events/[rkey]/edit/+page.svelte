<script lang="ts">
	import { EventEditor } from '@atmo-dev/events-ui';
	import { createGroupAdapter, groupViewer } from '#lib/groups/editor-adapter.js';

	let { data } = $props();

	let viewer = $derived(groupViewer(data.group));
	let adapter = $derived(createGroupAdapter(data.group.did, viewer));
</script>

<EventEditor
	eventData={data.eventData}
	actorDid={data.group.did}
	rkey={data.rkey}
	{adapter}
	{viewer}
/>

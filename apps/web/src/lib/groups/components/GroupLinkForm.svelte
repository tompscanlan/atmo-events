<script lang="ts">
	import type { Snippet } from 'svelte';

	// Starts linking the signed-in person's group session. A plain post, not a
	// remote form: the answer is a redirect to the group's PDS. Only someone
	// whose roles grant writes may link, and the route answers anyone else with
	// the group's 404.
	let {
		groupDid,
		class: className,
		children
	}: { groupDid: string; class?: string; children: Snippet } = $props();
</script>

<form method="POST" action="/oauth/group-link" class={className}>
	<input type="hidden" name="groupDid" value={groupDid} />
	{@render children()}
</form>

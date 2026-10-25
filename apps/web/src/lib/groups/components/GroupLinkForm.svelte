<script lang="ts">
	import type { Snippet } from 'svelte';

	// A plain post, not a remote form: the answer is a redirect to the group's host.
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

<script lang="ts">
	import type { Snippet } from 'svelte';

	// Starts linking the group's account. A plain post, not a remote form: the
	// answer is a redirect to the group's PDS. Only the owner may link, and the
	// route answers anyone else with the group's 404.
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

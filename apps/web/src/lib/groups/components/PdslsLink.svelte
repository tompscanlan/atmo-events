<script lang="ts">
	import type { Snippet } from 'svelte';
	import { pdslsUrl } from '../pdsls';

	// A record, space or account opened on pds.ls, in a new tab. `to` is an
	// at:// URI or a DID.
	let {
		to,
		title,
		class: className,
		children
	}: { to: string; title?: string; class?: string; children: Snippet } = $props();
</script>

<!-- Another site, so there is no route to resolve. -->
<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
<a href={pdslsUrl(to)} target="_blank" rel="noopener noreferrer" {title} class={className}
	>{@render children()}</a
>

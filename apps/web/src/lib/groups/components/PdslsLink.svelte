<script lang="ts">
	import type { Snippet } from 'svelte';
	import { pdslsUrl } from '../pdsls';

	// A record, space or account opened in the record browser, in a new tab. `to` is
	// an at:// URI or a DID. With no record browser on the network, the text alone.
	let {
		to,
		title,
		class: className,
		children
	}: { to: string; title?: string; class?: string; children: Snippet } = $props();
	const href = $derived(pdslsUrl(to));
</script>

{#if href}
	<!-- Another site, so there is no route to resolve. -->
	<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
	<a {href} target="_blank" rel="noopener noreferrer" {title} class={className}
		>{@render children()}</a
	>
{:else}
	<span {title}>{@render children()}</span>
{/if}

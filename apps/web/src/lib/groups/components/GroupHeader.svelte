<script lang="ts">
	import { Avatar, Badge, Button } from '@atmo-dev/kit';

	// A group's header, as a person's profile header is laid out (the kit's UserProfile), for a
	// group shown as a host of events: its picture, name, address and description, how many events
	// it has made, and its links. UserProfile itself offers to view the account on a social client,
	// which a group is not on.
	let {
		name,
		handle,
		description,
		website,
		home,
		isPrivate = false,
		eventsCreated = null
	}: {
		name: string;
		handle: string | null;
		description: string | null;
		/** The group's website: linked only when it is an http(s) URL. */
		website: string | null;
		/** The group's own address, from its verified handle. */
		home: string | null;
		isPrivate?: boolean;
		eventsCreated?: number | null;
	} = $props();

	/** Only an http(s) URL is ever a link, whatever reached the page. */
	function webAddress(value: string | null): URL | null {
		if (!value) return null;
		try {
			const url = new URL(value);
			return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
		} catch {
			return null;
		}
	}

	let site = $derived(webAddress(website));
	let homeUrl = $derived(webAddress(home));
</script>

<section class="text-base-950 dark:text-base-50 mb-10 min-w-0 pt-6 sm:pt-8" aria-label="Group">
	<div class="flex flex-wrap items-start justify-between gap-4">
		<Avatar {name} size={96} class="relative size-20 sm:size-24" />
		<div class="flex flex-wrap items-center gap-2">
			<Badge>Group</Badge>
			{#if isPrivate}<Badge>Private</Badge>{/if}
		</div>
	</div>
	<div class="mt-4 min-w-0">
		<h1 class="text-2xl font-semibold tracking-tight wrap-anywhere sm:text-3xl">
			<bdi>{name}</bdi>
		</h1>
		{#if handle}
			<p class="text-base-600 dark:text-base-400 mt-1 text-sm wrap-anywhere">
				<bdi>@{handle}</bdi>
			</p>
		{/if}
	</div>
	{#if eventsCreated !== null}
		<dl aria-label="Group statistics" class="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
			<div class="flex gap-1">
				<dd class="font-semibold">{eventsCreated.toLocaleString('en')}</dd>
				<dt class="text-base-600 dark:text-base-400">events created</dt>
			</div>
		</dl>
	{/if}
	{#if description}
		<p class="mt-4 text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap">{description}</p>
	{/if}
	{#if site || homeUrl}
		<ul aria-label="Group links" class="mt-4 flex flex-wrap gap-2">
			{#if site}
				<li class="max-w-full min-w-0">
					<Button
						href={site.href}
						target="_blank"
						rel="noopener noreferrer"
						variant="secondary"
						size="sm"
						class="max-w-full"
					>
						<span class="min-w-0 wrap-anywhere">Website: {site.hostname}</span><span
							aria-hidden="true">&nearr;</span
						>
					</Button>
				</li>
			{/if}
			{#if homeUrl}
				<!-- The group's own address, named as such: what is served there is the group's. -->
				<li class="max-w-full min-w-0">
					<Button
						href={homeUrl.href}
						target="_blank"
						rel="noopener noreferrer"
						variant="secondary"
						size="sm"
						class="max-w-full"
					>
						<span class="min-w-0 wrap-anywhere">Group home: {homeUrl.hostname}</span><span
							aria-hidden="true">&nearr;</span
						>
					</Button>
				</li>
			{/if}
		</ul>
	{/if}
</section>

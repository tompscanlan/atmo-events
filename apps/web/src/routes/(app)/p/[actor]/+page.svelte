<script lang="ts">
	import { getProfileBlobUrl, type FlatEventRecord } from '$lib/contrail';
	import { user, logout } from '$lib/atproto/auth.svelte';
	import UserProfile from '$lib/components/UserProfile.svelte';
	import { Button } from '@foxui/core';
	import { EventCard } from '@atmo-dev/events-ui';
	import { createEventModalState } from '$lib/components/CreateEventModal.svelte';

	let { data, form } = $props();

	let isOwnProfile = $derived(user.isLoggedIn && user.did === data.actorDid);
	let isCommunity = $derived(Boolean(data.community?.isCommunity));
	let communityMembers = $derived(data.community?.members ?? []);

	let hostProfile = $derived(data.actorProfile);
	let hostDid = $derived(data.actorDid as string);
	let hostName = $derived(hostProfile?.value?.displayName || hostProfile?.handle || hostDid);

	let now = $derived(new Date());

	let upcomingAttendingEvents = $derived(
		[...(data.attendingEvents ?? [])]
			.filter((event: FlatEventRecord) => {
				const endDate = new Date(event.endsAt || event.startsAt);
				return endDate >= now;
			})
			.sort(
				(a: FlatEventRecord, b: FlatEventRecord) =>
					new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
			)
	);
</script>

<svelte:head>
	<title>{hostName} - Events</title>
	<meta name="description" content="Events hosted by {hostName}" />
	<meta property="og:title" content="{hostName} - Events" />
	<meta property="og:description" content="Events hosted by {hostName}" />
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content="{hostName} - Events" />
	<meta name="twitter:description" content="Events hosted by {hostName}" />
</svelte:head>

<div class="px-6 py-1 sm:py-2">
	<div class="mx-auto max-w-2xl">
		<!-- Header -->
		<UserProfile
			profile={{
				handle: hostProfile?.handle,
				displayName: hostName,
				avatar: hostProfile?.value?.avatar
					? getProfileBlobUrl(hostDid, hostProfile.value.avatar)
					: undefined
			}}
		>
			{#snippet actions()}
				{#if isOwnProfile}
					<Button onclick={logout} variant="primary" class="rose">Logout</Button>
				{/if}
			{/snippet}
		</UserProfile>

		{#if isCommunity}
			<div class="-mt-2 mb-6 flex flex-wrap items-center gap-3 px-4 sm:px-6">
				<span
					class="border-base-300 bg-base-100 text-base-700 dark:border-base-700 dark:bg-base-900 dark:text-base-200 rounded-md border px-2 py-1 text-xs font-medium"
				>
					Group
				</span>
				{#if data.community?.authorityEndpoint}
					<span class="text-base-500 dark:text-base-400 text-xs">
						{data.community.authorityEndpoint}
					</span>
				{/if}
			</div>
		{/if}

		{#if isOwnProfile}
			<Button onclick={() => createEventModalState.show()} class="-mt-6 mb-6" size="lg">
				Create Event
			</Button>
		{/if}

		{#if isCommunity && user.isLoggedIn}
			<section class="mb-10">
				<div class="mb-4 flex items-baseline justify-between">
					<h2 class="text-base-900 dark:text-base-50 text-lg font-semibold">Publishers</h2>
					{#if data.community?.callerRole}
						<span class="text-base-500 dark:text-base-400 text-xs">
							Your role: {data.community.callerRole}
						</span>
					{/if}
				</div>

				{#if data.community?.membershipError}
					<p class="text-base-500 dark:text-base-400 text-sm">
						{data.community.membershipError}
					</p>
				{:else if communityMembers.length > 0}
					<div class="divide-base-200 dark:divide-base-800 divide-y">
						{#each communityMembers as member (member.did)}
							<div class="flex min-h-14 items-center justify-between gap-3 py-3">
								<a href="/p/{member.handle || member.did}" class="flex min-w-0 items-center gap-3">
									{#if member.avatar}
										<img
											src={member.avatar}
											alt=""
											class="bg-base-200 dark:bg-base-800 size-9 rounded-full object-cover"
										/>
									{:else}
										<div
											class="bg-base-200 text-base-600 dark:bg-base-800 dark:text-base-300 flex size-9 items-center justify-center rounded-full text-xs font-medium"
										>
											{(member.displayName || member.handle || member.did).slice(0, 2)}
										</div>
									{/if}
									<span class="min-w-0">
										<span
											class="text-base-900 dark:text-base-100 block truncate text-sm font-medium"
										>
											{member.displayName || member.handle || member.did}
										</span>
										<span class="text-base-500 dark:text-base-400 block truncate text-xs">
											{member.handle || member.did} · {member.accessLevel}
										</span>
									</span>
								</a>

								{#if data.community?.canManage}
									<form
										method="POST"
										action="?/revokePublisher"
										onsubmit={(event) => {
											if (!confirm('Remove this publisher?')) event.preventDefault();
										}}
									>
										<input type="hidden" name="did" value={member.did} />
										<button
											type="submit"
											class="text-base-500 dark:text-base-400 px-2 py-1 text-sm hover:text-red-600 dark:hover:text-red-400"
										>
											Remove
										</button>
									</form>
								{/if}
							</div>
						{/each}
					</div>
				{:else}
					<p class="text-base-500 dark:text-base-400 text-sm">No publishers yet.</p>
				{/if}

				{#if data.community?.canManage}
					<form
						method="POST"
						action="?/grantPublisher"
						class="mt-5 flex flex-col gap-2 sm:flex-row"
					>
						<input
							name="actor"
							placeholder="Handle or DID"
							class="border-base-300 bg-base-50 text-base-900 placeholder:text-base-400 dark:border-base-700 dark:bg-base-950 dark:text-base-100 min-h-10 flex-1 rounded-md border px-3 text-sm"
						/>
						<button
							type="submit"
							class="bg-accent-600 hover:bg-accent-700 text-base-50 min-h-10 rounded-md px-4 text-sm font-medium"
						>
							Add publisher
						</button>
					</form>
					{#if form?.message}
						<p class="mt-2 text-sm text-red-600 dark:text-red-400">{form.message}</p>
					{/if}
				{/if}
			</section>
		{/if}

		<!-- Upcoming Events -->
		{#if (data.upcomingEvents?.length ?? 0) > 0}
			<section class="mb-10">
				<div class="mb-4 flex items-baseline justify-between">
					<h2 class="text-base-900 dark:text-base-50 text-lg font-semibold">Upcoming Events</h2>
					{#if data.hasMoreUpcoming}
						<a
							href="/p/{data.actor}/hosting"
							class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 text-sm font-medium transition-colors"
						>
							See all &rarr;
						</a>
					{/if}
				</div>
				<div class="space-y-5">
					{#each data.upcomingEvents as event (event.uri)}
						<EventCard {event} actor={data.actor} />
					{/each}
				</div>
			</section>
		{/if}

		<!-- Attending -->
		{#if !isCommunity && upcomingAttendingEvents.length > 0}
			<section class="mb-10">
				<h2 class="text-base-900 dark:text-base-50 mb-4 text-lg font-semibold">Attending</h2>
				<div class="space-y-5">
					{#each upcomingAttendingEvents as event (event.uri)}
						<EventCard {event} />
					{/each}
				</div>
			</section>
		{/if}

		<!-- Past Events -->
		{#if (data.pastEvents?.length ?? 0) > 0}
			<section class="mb-10">
				<div class="mb-4 flex items-baseline justify-between">
					<h2 class="text-base-900 dark:text-base-50 text-lg font-semibold">Past Events</h2>
					{#if data.hasMorePast}
						<a
							href="/p/{data.actor}/past-events"
							class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 text-sm font-medium transition-colors"
						>
							See all &rarr;
						</a>
					{/if}
				</div>
				<div class="space-y-5">
					{#each data.pastEvents as event (event.uri)}
						<EventCard {event} actor={data.actor} />
					{/each}
				</div>
			</section>
		{/if}

		{#if !data.upcomingEvents?.length && !upcomingAttendingEvents.length && !data.pastEvents?.length}
			<div
				class="border-base-200 dark:border-base-800 bg-base-100 dark:bg-base-950/50 rounded-2xl border p-8 text-center"
			>
				<p class="text-base-500 dark:text-base-400 py-12 text-center">
					{isCommunity
						? "This group hasn't created any events yet."
						: isOwnProfile
							? "You haven't created or attended any events yet."
							: "This person hasn't created or attended any events yet."}
				</p>
			</div>
		{/if}
	</div>
</div>

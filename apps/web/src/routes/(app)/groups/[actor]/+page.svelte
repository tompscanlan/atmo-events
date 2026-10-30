<script lang="ts">
	import { Avatar, Badge, Button } from '@atmo-dev/kit';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { requestPermissions } from '@svelte-atproto/oauth/client';
	import EventList from '#lib/components/EventList.svelte';
	import {
		finishGroupSetup,
		setGroupListed,
		unlinkGroupSession
	} from '#lib/groups/group.remote.js';
	import { cancelJoin, joinGroup, leave } from '#lib/groups/members.remote.js';
	import { GROUP_PERSON_SCOPES } from '#lib/groups/scopes.js';

	let { data } = $props();

	let group = $derived(data.group);
	let joinPolicy = $derived(group.personal?.profile?.joinPolicy ?? 'invite');
	let busy = $state(false);
	let failure: string | null = $state(null);
	let requested = $state(false);

	/** A refusal the host gave comes back in words to show; anything else is generic. */
	function messageOf(e: unknown): string {
		const message = (e as { body?: { message?: unknown } })?.body?.message;
		return typeof message === 'string' && (e as { status?: number }).status === 409
			? message
			: 'That did not work. Try again, or link the group again.';
	}

	async function act(run: () => Promise<unknown>, after: () => Promise<void> = invalidateAll) {
		busy = true;
		failure = null;
		try {
			await run();
			await after();
		} catch (e) {
			failure = messageOf(e);
		} finally {
			busy = false;
		}
	}

	async function join() {
		await act(async () => {
			const { outcome } = await joinGroup({ groupDid: group.did });
			requested = outcome === 'pending';
		});
	}
</script>

<div class="min-h-screen px-6 py-12 sm:py-12">
	<div class="mx-auto max-w-2xl">
		<div class="mb-6">
			<a
				href={resolve('/(app)/groups')}
				class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 text-sm font-medium transition-colors"
			>
				&larr; All groups
			</a>
		</div>

		<header class="flex items-start gap-4">
			<Avatar name={group.name} size={56} />
			<div class="min-w-0">
				<h1 class="text-base-900 dark:text-base-50 flex items-center gap-2 text-2xl font-bold">
					{group.name}
					{#if group.personal && !group.personal.public}<Badge>Private</Badge>{/if}
				</h1>
				{#if group.handle}<p class="text-muted text-sm">@{group.handle}</p>{/if}
				{#if group.description}
					<p class="text-base-700 dark:text-base-300 mt-2 whitespace-pre-line">
						{group.description}
					</p>
				{/if}
			</div>
		</header>

		{#if data.notice}<p role="status" class="text-muted mt-4 text-sm">{data.notice}</p>{/if}
		{#if failure}<p role="alert" class="mt-4 text-sm text-red-600">{failure}</p>{/if}

		{#if group.askAccess}
			<div class="mt-6 flex flex-wrap items-center gap-3">
				<Button
					variant="secondary"
					disabled={busy}
					onclick={() =>
						act(
							() => requestPermissions(GROUP_PERSON_SCOPES),
							async () => undefined
						)}>See your groups</Button
				>
				<span class="text-muted text-sm">
					To see the groups you belong to, private ones too, allow atmo to read them.
				</span>
			</div>
		{/if}

		{#if group.personal && group.member !== null}
			<section class="mt-6 flex flex-wrap items-center gap-3" aria-label="Membership">
				{#if group.member}
					<Badge>Member</Badge>
					<Button
						variant="ghost"
						disabled={busy}
						onclick={() => act(() => leave({ groupDid: group.did }))}>Leave group</Button
					>
				{:else if requested}
					<span class="text-muted text-sm">Request sent. An admin of the group will decide.</span>
					<Button
						variant="ghost"
						disabled={busy}
						onclick={() =>
							act(async () => {
								await cancelJoin({ groupDid: group.did });
								requested = false;
							})}>Withdraw</Button
					>
				{:else if joinPolicy === 'open'}
					<Button variant="primary" disabled={busy} onclick={join}>Join</Button>
				{:else if joinPolicy === 'approval'}
					<Button variant="secondary" disabled={busy} onclick={join}>Ask to join</Button>
				{:else}
					<span class="text-muted text-sm">This group is invite-only.</span>
				{/if}
			</section>
		{/if}

		{#if data.unfinished}
			<div class="mt-6 flex flex-wrap items-center gap-3">
				<Button
					variant="primary"
					disabled={busy}
					onclick={() => act(() => finishGroupSetup({ groupDid: group.did }))}
					>Finish setting up</Button
				>
				<span class="text-muted text-sm"
					>Its name, visibility and listing are not all saved yet.</span
				>
			</div>
		{/if}

		{#if group.linked}
			<section class="mt-6 flex flex-wrap items-center gap-2" aria-label="Manage this group">
				<Button
					href={resolve('/(app)/groups/[actor]/events/new', { actor: group.did })}
					variant="primary">Post an event</Button
				>
				<Button
					href={resolve('/(app)/groups/[actor]/settings', { actor: group.did })}
					variant="secondary">Settings</Button
				>
				{#if group.linked.listed}
					<Button
						variant="secondary"
						disabled={busy}
						onclick={() => act(() => setGroupListed({ groupDid: group.did, listed: false }))}
						>Remove from the groups list</Button
					>
				{:else if group.linked.meta.public}
					<Button
						variant="secondary"
						disabled={busy}
						onclick={() => act(() => setGroupListed({ groupDid: group.did, listed: true }))}
						>Add to the groups list</Button
					>
				{:else}
					<Badge>Private</Badge>
				{/if}
				<Button
					variant="ghost"
					disabled={busy}
					onclick={() =>
						act(
							() => unlinkGroupSession({ groupDid: group.did }),
							() => goto(resolve('/(app)/groups'), { invalidateAll: true })
						)}>Unlink</Button
				>
			</section>
		{:else if group.atHost && data.signedIn}
			<form method="POST" action="/oauth/group/link" class="mt-6 flex flex-wrap items-center gap-3">
				<input type="hidden" name="group" value={group.did} />
				<Button type="submit" variant="secondary">
					{group.relink ? 'Link again' : 'Link this group'}
				</Button>
				<span class="text-muted text-sm">
					{group.relink
						? 'Your link to this group stopped working.'
						: 'If you have a role in this group, link it to post its events.'}
				</span>
			</form>
		{/if}

		{#if group.personal}
			<a
				href={resolve('/(app)/groups/[actor]/members', { actor: group.did })}
				class="text-accent-600 dark:text-accent-400 mt-6 inline-block text-sm font-medium"
				>Members &rarr;</a
			>
		{/if}

		<h2 class="text-base-900 dark:text-base-50 mt-10 text-lg font-semibold">Upcoming events</h2>
		{#if data.events.length > 0}
			<div class="mt-4">
				<EventList
					events={data.events}
					cursor={data.cursor}
					actor={group.did}
					ongoingSeeAllHref={null}
					gridClass="space-y-3"
				/>
			</div>
			{#if group.linked}
				<ul class="mt-6 space-y-1 text-sm" aria-label="Edit events">
					{#each data.events as event (event.uri)}
						<li class="flex justify-between gap-3">
							<span class="truncate">{event.name}</span>
							<a
								class="text-accent-600 dark:text-accent-400 shrink-0 font-medium"
								href={resolve('/(app)/groups/[actor]/events/[rkey]/edit', {
									actor: group.did,
									rkey: event.rkey
								})}>Edit</a
							>
						</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<p class="text-muted py-8 text-center">No upcoming events.</p>
		{/if}
		<a
			href={resolve('/(app)/p/[actor]/past-events', { actor: group.did })}
			class="text-accent-600 dark:text-accent-400 mt-4 inline-block text-sm font-medium"
			>Past events &rarr;</a
		>
	</div>
</div>

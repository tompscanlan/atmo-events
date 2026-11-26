<script lang="ts">
	import { Avatar, Badge, Button, Label, Textarea } from '@atmo-dev/kit';
	import { isHttpError } from '@sveltejs/kit';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import EventList from '#lib/components/EventList.svelte';
	import GroupAccessNotice from '#lib/groups/components/GroupAccessNotice.svelte';
	import { JOIN_MESSAGE_MAX } from '#lib/groups/fields.js';
	import {
		finishGroupSetup,
		setGroupListed,
		unlinkGroupSession
	} from '#lib/groups/group.remote.js';
	import { cancelJoin, joinGroup, leave } from '#lib/groups/members.remote.js';

	let { data } = $props();

	let group = $derived(data.group);
	let busy = $state(false);
	let failure: string | null = $state(null);
	/** A request sent from this page, shown until the page is loaded again: the spec has no way to
	 *  read one back, and asking again is answered with the same request. */
	let requested = $state(false);
	let message = $state('');
	/** Members see who else is in the group; an admin who linked it, also those asking to join. */
	let showMembers = $derived(
		group.member === true ||
			Boolean(group.linked && (group.linked.can.admit || group.linked.can.remove))
	);

	/** The person's own membership: the host's refusals come back in words to show. */
	async function asMember(run: () => Promise<unknown>) {
		busy = true;
		failure = null;
		try {
			await run();
		} catch (e) {
			failure = isHttpError(e) ? e.body.message : 'That did not work. Try again.';
		} finally {
			busy = false;
		}
	}

	const join = () =>
		asMember(async () => {
			const { outcome } = await joinGroup({ groupDid: group.did, message: message || undefined });
			if (outcome === 'pending') requested = true;
			else await invalidateAll();
		});

	const cancel = () =>
		asMember(async () => {
			await cancelJoin({ groupDid: group.did });
			requested = false;
			// Admitted meanwhile, perhaps.
			await invalidateAll();
		});

	const leaveIt = () =>
		asMember(async () => {
			await leave({ groupDid: group.did });
			await invalidateAll();
		});

	async function act(run: () => Promise<unknown>, after: () => Promise<void> = invalidateAll) {
		busy = true;
		failure = null;
		try {
			await run();
			await after();
		} catch (e) {
			// The server says why where it can: the group is private, or the caller's role changed.
			failure =
				isHttpError(e, 409) || isHttpError(e, 403)
					? e.body.message
					: 'That did not work. Try again, or link the group again.';
		} finally {
			busy = false;
		}
	}

	const unlink = () =>
		act(
			() => unlinkGroupSession({ groupDid: group.did }),
			() => goto(resolve('/(app)/groups'), { invalidateAll: true })
		);
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
					{#if group.personal && !group.personal.public && !group.linked}<Badge>Private</Badge>{/if}
				</h1>
				{#if group.handle}<p class="text-base-600 dark:text-base-400 text-sm">
						@{group.handle}
					</p>{/if}
				{#if group.description}
					<p class="text-base-700 dark:text-base-300 mt-2 whitespace-pre-line">
						{group.description}
					</p>
				{/if}
			</div>
		</header>

		{#if data.notice}<p role="status" class="text-base-600 dark:text-base-400 mt-4 text-sm">
				{data.notice}
			</p>{/if}
		{#if failure}<p role="alert" class="text-base-950 dark:text-base-50 mt-4 text-sm">
				{failure}
			</p>{/if}

		{#if data.access && data.you}
			<GroupAccessNotice
				kind="participate"
				access={data.access}
				did={data.you}
				purpose="To join this group, or see it as one of its members, atmo asks your server to act for you in groups."
				spacesServer={data.spacesServer}
			/>
		{/if}

		{#if group.personal && group.member !== null}
			<section class="mt-6" aria-label="Membership">
				{#if group.member}
					<div class="flex flex-wrap items-center gap-3">
						<Badge>Member</Badge>
						<Button variant="ghost" disabled={busy} onclick={leaveIt}>Leave group</Button>
					</div>
				{:else if requested}
					<div class="flex flex-wrap items-center gap-3">
						<p class="text-base-700 dark:text-base-300 text-sm" role="status">
							Request sent. The group's admins will decide.
						</p>
						<Button variant="ghost" disabled={busy} onclick={cancel}>Cancel request</Button>
					</div>
				{:else if group.personal.joinPolicy === 'open'}
					<Button variant="primary" disabled={busy} onclick={join}>Join</Button>
				{:else if group.personal.joinPolicy === 'approval'}
					<div class="space-y-2">
						<Label for="join-message">A message for the group's admins (optional)</Label>
						<Textarea
							id="join-message"
							bind:value={message}
							rows={3}
							maxlength={JOIN_MESSAGE_MAX}
						/>
						<div class="flex flex-wrap items-center gap-3">
							<Button variant="secondary" disabled={busy} onclick={join}>Ask to join</Button>
							<span class="text-base-600 dark:text-base-400 text-sm">
								The group's admins decide who joins.
							</span>
						</div>
					</div>
				{:else}
					<p class="text-base-600 dark:text-base-400 text-sm" role="status">
						This group takes members by invitation only.
					</p>
				{/if}
			</section>
		{/if}

		{#if showMembers}
			<a
				href={resolve('/(app)/groups/[actor]/members', { actor: group.did })}
				class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 mt-4 inline-block text-sm font-medium transition-colors"
				>Members &rarr;</a
			>
		{/if}

		{#if group.linked}
			<section class="mt-6 flex flex-wrap items-center gap-2" aria-label="Manage this group">
				{#if group.linked.can.post}
					<Button
						href={resolve('/(app)/groups/[actor]/events/new', { actor: group.did })}
						variant="primary">Post an event</Button
					>
				{/if}
				{#if !group.linked.meta.public}
					<Badge>Private</Badge>
					{#if group.linked.can.list}
						<span class="text-base-600 dark:text-base-400 text-sm">
							Only a public group can be on the groups list.
						</span>
					{/if}
				{:else if group.linked.can.list && group.linked.listed}
					<Button
						variant="secondary"
						disabled={busy}
						onclick={() => act(() => setGroupListed({ groupDid: group.did, listed: false }))}
						>Remove from the groups list</Button
					>
				{:else if group.linked.can.list}
					<Button
						variant="secondary"
						disabled={busy}
						onclick={() => act(() => setGroupListed({ groupDid: group.did, listed: true }))}
						>Add to the groups list</Button
					>
				{/if}
				{#if group.linked.can.settings}
					<Button
						href={resolve('/(app)/groups/[actor]/settings', { actor: group.did })}
						variant="secondary">Settings</Button
					>
				{/if}
				<Button variant="ghost" disabled={busy} onclick={unlink}>Unlink</Button>
			</section>
			{#if group.linked.unfinished}
				<div class="mt-3 flex flex-wrap items-center gap-3">
					<p class="text-base-700 dark:text-base-300 text-sm" role="status">
						Setting up this group didn't finish: it is still on the groups list, which you asked it
						not to be.
					</p>
					<Button
						size="sm"
						variant="secondary"
						disabled={busy}
						onclick={() => act(() => finishGroupSetup({ groupDid: group.did }))}
						>Finish setting up</Button
					>
				</div>
			{/if}
			{#if group.linked.reapprove}
				<form
					method="POST"
					action="/oauth/group/link"
					class="mt-3 flex flex-wrap items-center gap-3"
				>
					<input type="hidden" name="group" value={group.did} />
					<span class="text-base-600 dark:text-base-400 text-sm">
						Your link was approved before atmo asked for all it can do for a group.
					</span>
					<Button type="submit" size="sm" variant="secondary">Approve again</Button>
				</form>
			{:else if !group.linked.can.post && !group.linked.can.list}
				<p class="text-base-600 dark:text-base-400 mt-2 text-sm" role="status">
					Your role in this group lets you see it here, but not post its events or list it.
				</p>
			{/if}
		{:else if group.atHost && data.signedIn}
			<div class="mt-6 flex flex-wrap items-center gap-3">
				<form method="POST" action="/oauth/group/link" class="contents">
					<input type="hidden" name="group" value={group.did} />
					<Button type="submit" variant="secondary">
						{group.relink ? 'Link again' : 'Link this group'}
					</Button>
					<span class="text-base-600 dark:text-base-400 text-sm">
						{group.relink
							? 'Your link to this group stopped working.'
							: 'If you have a role in this group, link it to post its events.'}
					</span>
				</form>
				<!-- A link the host refuses, or one that broke, can still come off. -->
				{#if group.hasLink}
					<Button variant="ghost" disabled={busy} onclick={unlink}>Unlink</Button>
				{/if}
			</div>
		{:else if group.hasLink}
			<!-- Not at this site's group host any more, so it can't be linked again, only unlinked. -->
			<div class="mt-6">
				<Button variant="ghost" disabled={busy} onclick={unlink}>Unlink</Button>
			</div>
		{/if}

		<h2 class="text-base-900 dark:text-base-50 mt-8 text-lg font-semibold">Upcoming events</h2>
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
			{#if group.linked?.can.post}
				<ul class="mt-6 space-y-2 text-sm" aria-label="Edit events">
					{#each data.events as event (event.uri)}
						<li class="flex justify-between gap-3">
							<span class="truncate">{event.name}</span>
							<a
								class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 shrink-0 font-medium transition-colors"
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
			<p class="text-base-600 dark:text-base-400 py-12 text-center">No upcoming events.</p>
		{/if}
		<a
			href={resolve('/(app)/p/[actor]/past-events', { actor: group.did })}
			class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 mt-4 inline-block text-sm font-medium transition-colors"
			>Past events &rarr;</a
		>
	</div>
</div>

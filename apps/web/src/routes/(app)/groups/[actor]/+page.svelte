<script lang="ts">
	import { Avatar, Badge, Button, Icon, Label, Textarea } from '@atmo-dev/kit';
	import { EventCard } from '@atmo-dev/kit/events';
	import { LockKeyhole } from '@sketchyicons/svelte';
	import { isHttpError } from '@sveltejs/kit';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import EventList from '#lib/components/EventList.svelte';
	import GroupAccessNotice from '#lib/groups/components/GroupAccessNotice.svelte';
	import { JOIN_MESSAGE_MAX } from '#lib/groups/fields.js';
	import {
		finishGroupSetup,
		setGroupListed,
		turnOnMembersOnlyEvents,
		unlinkGroupSession
	} from '#lib/groups/group.remote.js';
	import { cancelJoin, confirmMember, joinGroup, leave } from '#lib/groups/members.remote.js';

	let { data } = $props();

	let group = $derived(data.group);
	let busy = $state(false);
	let failure: string | null = $state(null);
	/** A request sent from this page, shown until the page is loaded again: the spec has no way to
	 *  read one back, and asking again is answered with the same request. Kept for the group it was
	 *  sent to, since moving to another group's page keeps this component. */
	let requestedOf: string | null = $state(null);
	let requested = $derived(requestedOf === group.did);
	let message = $state('');
	// A message typed for one group is not carried to another's page.
	let messageOf: string | null = null;
	$effect.pre(() => {
		if (group.did !== messageOf) {
			messageOf = group.did;
			message = '';
		}
	});
	/** Members-only events are on, and this link may post them. */
	let postsMembersOnly = $derived(
		data.calendar === 'ready' && Boolean(group.linked?.can.membersOnly)
	);
	/** Members see who else is in the group; an admin who linked it, also those asking to join. As
	 *  the members page lets in only someone the host's records count a member, so is the link. */
	let showMembers = $derived(group.member === true);

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
			if (outcome === 'pending') requestedOf = group.did;
			else await invalidateAll();
		});

	const cancel = () =>
		asMember(async () => {
			await cancelJoin({ groupDid: group.did });
			requestedOf = null;
			// Admitted meanwhile, perhaps.
			await invalidateAll();
		});

	const confirm = () =>
		asMember(async () => {
			await confirmMember({ groupDid: group.did });
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

<!-- For an admin who linked a group that approves its members: where requests to join wait. One
     snippet and its one use, to drop wherever the page lists the requests itself. -->
{#snippet joinRequestsWaitAtHost()}
	{#if group.linked && group.linked.meta.joinPolicy === 'approval' && (group.linked.can.settings || group.linked.can.admit)}
		<p class="text-base-600 dark:text-base-400 mt-3 text-sm">
			Requests to join this group are kept at the group host, where its admins admit or decline
			them.
		</p>
	{/if}
{/snippet}

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
		{#if group.unreachable}<p role="status" class="text-base-600 dark:text-base-400 mt-4 text-sm">
				The group host couldn't be reached through your link just now, so this page shows the group
				as anyone sees it. Try again shortly.
			</p>{/if}
		{#if failure}<p role="alert" class="text-base-950 dark:text-base-50 mt-4 text-sm">
				{failure}
			</p>{/if}

		{#if data.access && data.you}
			<GroupAccessNotice
				kind="participate"
				access={data.access}
				did={data.you}
				purpose={data.accessForMembersOnly
					? "To see this group's members-only events and RSVP to them, atmo asks your server to act for you in groups."
					: 'To join this group, or see it as one of its members, atmo asks your server to act for you in groups.'}
				spacesServer={data.spacesServer}
			/>
		{/if}

		{#if group.personal && group.member === null}
			<p class="text-base-600 dark:text-base-400 mt-6 text-sm" role="status">
				Whether you're a member of this group couldn't be checked just now. Try again shortly.
			</p>
		{:else if group.personal}
			<section class="mt-6" aria-label="Membership">
				{#if group.member}
					<div class="flex flex-wrap items-center gap-3">
						<Badge>Member</Badge>
						<Button variant="ghost" disabled={busy} onclick={leaveIt}>Leave group</Button>
					</div>
					{#if group.confirmed === false}
						<!-- Admitted some other way than a request made here: confirming is theirs to do. -->
						<div class="mt-3 flex flex-wrap items-center gap-3">
							<p class="text-base-700 dark:text-base-300 text-sm" role="status">
								The group counts you a member. Confirm it to be listed among its members.
							</p>
							<Button size="sm" variant="secondary" disabled={busy} onclick={confirm}
								>Confirm membership</Button
							>
						</div>
					{/if}
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
				{#if group.linked.can.post || postsMembersOnly}
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
			{@render joinRequestsWaitAtHost()}
			{#if group.linked.unfinished}
				<div class="mt-3 flex flex-wrap items-center gap-3">
					<p class="text-base-700 dark:text-base-300 text-sm" role="status">
						{#if group.linked.unfinished.public && !group.linked.unfinished.listed}
							Setting up this group didn't finish: it isn't yet public and off the groups list, as
							you asked.
						{:else}
							Setting up this group here didn't finish.
						{/if}
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
			{#if data.calendar && data.calendar !== 'ready' && data.calendar !== 'missing'}
				<p class="text-base-600 dark:text-base-400 mt-3 text-sm" role="status">
					{data.calendar === 'readable'
						? "This group's calendar can be read by more than its members, so atmo posts no members-only events to it."
						: data.calendar === 'unusable'
							? "This group's calendar wasn't set up for atmo to post members-only events to, so atmo posts none to it."
							: data.calendar === 'no-role'
								? "Your role in this group doesn't let you post to its calendar, so atmo can't post members-only events for you, and approving your link again won't change that."
								: "Whether members-only events are on couldn't be checked just now. Reload to try again."}
				</p>
			{:else if data.calendar && !postsMembersOnly}
				<!-- Turning them on makes the calendar space; the host gives a link no scope for a space
				     that was not there when it was approved, so the link is approved once more. -->
				<section
					class="rounded-ui border-base-200 dark:border-base-800 mt-4 border p-4"
					aria-label="Members-only events"
					data-testid="members-only-setup"
				>
					<h2 class="text-base-900 dark:text-base-50 text-sm font-semibold">Members-only events</h2>
					<p class="text-base-700 dark:text-base-300 mt-1 text-sm">
						Events only this group's members can see, posted from this page as the group.
					</p>
					<ol class="text-base-700 dark:text-base-300 mt-2 list-decimal space-y-1 pl-5 text-sm">
						<li class:font-medium={data.calendar === 'missing'}>
							Turn them on. atmo makes the group a calendar only its members can read.
						</li>
						<li class:font-medium={data.calendar === 'ready'}>
							Approve your link once more, so it may post to that calendar.
						</li>
						<li>Post an event, and choose Members only.</li>
					</ol>
					{#if data.calendar === 'missing' && group.linked.can.turnOnMembersOnly}
						<Button
							class="mt-3"
							size="sm"
							variant="secondary"
							disabled={busy}
							onclick={() => act(() => turnOnMembersOnlyEvents({ groupDid: group.did }))}
							>Turn on members-only events</Button
						>
					{:else if data.calendar === 'ready'}
						<form method="POST" action="/oauth/group/link" class="mt-3">
							<input type="hidden" name="group" value={group.did} />
							<Button type="submit" size="sm" variant="secondary">Approve once more</Button>
						</form>
					{/if}
				</section>
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
		{:else if group.atHost && data.signedIn && !group.unreachable}
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
		{#if data.membersOnly}
			<section class="mt-8" aria-labelledby="members-only-heading">
				<h2 id="members-only-heading" class="text-base-900 dark:text-base-50 text-lg font-semibold">
					Members-only events
				</h2>
				{#if data.membersOnly.stoppedAt}
					<p class="text-base-600 dark:text-base-400 mt-2 text-sm" role="status">
						atmo stopped reading this group's calendar at {data.membersOnly.stoppedAt} events, so some
						upcoming ones may be missing here.
					</p>
				{/if}
				{#if data.membersOnly.unread}
					<p class="text-base-600 dark:text-base-400 mt-2 text-sm" role="status">
						Members-only events couldn't be loaded right now. Try again shortly.
					</p>
				{:else if data.membersOnly.events.length > 0}
					<ul class="mt-4 space-y-3">
						{#each data.membersOnly.events as event (event.uri)}
							{@const href = resolve('/(app)/groups/[actor]/events/[rkey]', {
								actor: group.did,
								rkey: event.rkey
							})}
							<li data-testid="members-only-event">
								<EventCard {event} {href} />
								<p class="text-base-600 dark:text-base-400 mt-1 flex gap-3 text-xs">
									<span>
										<Icon img={LockKeyhole} size={12} class="mr-1 inline align-[-2px]" />Members
										only
									</span>
									{#if postsMembersOnly}
										<a
											class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 font-medium transition-colors"
											href={resolve('/(app)/groups/[actor]/events/[rkey]/edit', {
												actor: group.did,
												rkey: event.rkey
											})}>Edit</a
										>
									{/if}
								</p>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-base-600 dark:text-base-400 py-6 text-center text-sm">
						No upcoming members-only events.
					</p>
				{/if}
			</section>
		{/if}
		<a
			href={resolve('/(app)/p/[actor]/past-events', { actor: group.did })}
			class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 mt-4 inline-block text-sm font-medium transition-colors"
			>Past events &rarr;</a
		>
	</div>
</div>

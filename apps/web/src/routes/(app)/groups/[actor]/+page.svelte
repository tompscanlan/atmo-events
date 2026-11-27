<script lang="ts">
	import { Badge, Button, Checkbox, Label, Textarea } from '@atmo-dev/kit';
	import { isHttpError } from '@sveltejs/kit';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import HappeningNow from '#lib/components/HappeningNow.svelte';
	import HostEventsSection from '#lib/components/HostEventsSection.svelte';
	import GroupAccessNotice from '#lib/groups/components/GroupAccessNotice.svelte';
	import GroupHeader from '#lib/groups/components/GroupHeader.svelte';
	import { JOIN_MESSAGE_MAX } from '#lib/groups/fields.js';
	import { setGroupListed, unlinkGroupSession } from '#lib/groups/group.remote.js';
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
	/** Private as the person or their link reads it; a visitor sees no private group at all. */
	let isPrivate = $derived(
		group.linked ? !group.linked.meta.public : group.personal ? !group.personal.public : false
	);
	/** Someone who linked the group and may do something with it here gets the tools. */
	let hasTools = $derived(
		Boolean(
			group.linked && (group.linked.can.post || group.linked.can.list || group.linked.reapprove)
		)
	);
	let hasEvents = $derived(
		data.ongoingEvents.length > 0 || data.upcomingEvents.length > 0 || data.pastEvents.length > 0
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

	/** The listing switch, shown as the group's listing stands after the try, taken or not. */
	async function toggleListed(box: HTMLInputElement) {
		const listed = box.checked;
		await act(() => setGroupListed({ groupDid: group.did, listed }));
		box.checked = group.linked?.listed ?? !listed;
	}

	const unlink = () =>
		act(
			() => unlinkGroupSession({ groupDid: group.did }),
			() => goto(resolve('/(app)/groups'), { invalidateAll: true })
		);
</script>

<!-- For anyone who linked the group: its name, description and who may join, its members, those
     asking to join and their roles are kept at the group host, and managed there, and the tools
     link there. The link is to the group host's own site, the origin of the group's PDS, named by
     its host name: never the group's own address, which may be any website. -->
{#snippet hostLink(site: { url: string; name: string })}
	<!-- eslint-disable svelte/no-navigation-without-resolve -->
	<a
		href={site.url}
		target="_blank"
		rel="noopener noreferrer"
		class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 font-medium transition-colors"
		>{site.name} <span aria-hidden="true">&nearr;</span></a
	><!-- eslint-enable svelte/no-navigation-without-resolve -->
{/snippet}
{#snippet managedAtHost()}
	{#if group.linked}
		<p class="text-base-600 dark:text-base-400 text-sm">
			The group's name, description and who may join are changed at its group host{#if group.hostSite},
				{@render hostLink(group.hostSite)}{/if}, as are its members, requests to join and roles.
		</p>
	{/if}
{/snippet}

<!-- A group's page shows it as a host of events, laid out as a person's profile is. -->
<div class="px-6 py-1 sm:py-2">
	<div class="mx-auto max-w-2xl">
		<GroupHeader
			name={group.name}
			handle={group.handle}
			description={group.description}
			website={group.website}
			home={group.home}
			{isPrivate}
			eventsCreated={data.eventsCreated}
		>
			{#snippet actions()}
				{#if group.personal && group.member}
					<Badge>Member</Badge>
					<Button size="sm" variant="ghost" disabled={busy} onclick={leaveIt}>Leave group</Button>
				{:else if group.personal && group.member === false && !requested && group.personal.joinPolicy === 'open'}
					<Button size="sm" variant="primary" disabled={busy} onclick={join}>Join</Button>
				{/if}
			{/snippet}
			<!-- The person's own place in the group, as far as the host lets them read it. -->
			{#if group.personal}
				<section class="mt-4" aria-label="Membership">
					{#if group.member === null}
						<p class="text-base-600 dark:text-base-400 text-sm" role="status">
							Whether you're a member of this group couldn't be checked just now. Try again shortly.
						</p>
					{:else if group.member}
						{#if group.confirmed === false}
							<!-- Admitted some other way than a request made here: confirming is theirs to do. -->
							<div class="flex flex-wrap items-center gap-3">
								<p class="text-base-700 dark:text-base-300 text-sm" role="status">
									The group counts you a member. Confirm it, so your own account says so too.
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
							<Button size="sm" variant="ghost" disabled={busy} onclick={cancel}
								>Cancel request</Button
							>
						</div>
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
					{:else if group.personal.joinPolicy !== 'open'}
						<p class="text-base-600 dark:text-base-400 text-sm" role="status">
							This group takes members by invitation only.
						</p>
					{/if}
				</section>
			{/if}
		</GroupHeader>

		{#if data.notice}<p role="status" class="text-base-600 dark:text-base-400 mb-6 text-sm">
				{data.notice}
			</p>{/if}
		{#if group.unreachable}<p role="status" class="text-base-600 dark:text-base-400 mb-6 text-sm">
				The group host couldn't be reached through your link just now, so this page shows the group
				as anyone sees it. Try again shortly.
			</p>{/if}
		{#if failure}<p role="alert" class="text-base-950 dark:text-base-50 mb-6 text-sm">
				{failure}
			</p>{/if}

		{#if data.access && data.you}
			<div class="mb-6">
				<GroupAccessNotice
					access={data.access}
					did={data.you}
					purpose="To join this group, or see it as one of its members, atmo asks your server to act for you in groups."
					spacesServer={data.spacesServer}
				/>
			</div>
		{/if}

		{#if group.linked && hasTools}
			<section
				class="rounded-ui border-base-200 dark:border-base-800 mb-10 space-y-4 border p-4"
				aria-labelledby="group-tools-heading"
			>
				<h2 id="group-tools-heading" class="text-base-900 dark:text-base-50 text-sm font-semibold">
					Group tools
				</h2>
				<div class="flex flex-wrap items-center gap-2">
					{#if group.linked.can.post}
						<Button
							href={resolve('/(app)/groups/[actor]/events/new', { actor: group.did })}
							variant="primary">Post an event</Button
						>
					{/if}
					{#if group.hostSite}
						<!-- The group host's own site, in a new tab that can't reach back. -->
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<Button
							href={group.hostSite.url}
							target="_blank"
							rel="noopener noreferrer"
							variant="secondary"
							>Group host: {group.hostSite.name} <span aria-hidden="true">&nearr;</span></Button
						><!-- eslint-enable svelte/no-navigation-without-resolve -->
					{/if}
					<Button variant="ghost" disabled={busy} onclick={unlink}>Unlink</Button>
				</div>
				{#if group.linked.can.list}
					<!-- The declaration in the group's own repo, which every app's group lists read. -->
					<div class="flex flex-wrap items-center gap-2">
						<Checkbox
							id="group-listed"
							role="switch"
							checked={group.linked.meta.public && group.linked.listed}
							disabled={busy || !group.linked.meta.public}
							onchange={(e) => toggleListed(e.currentTarget)}
						/>
						<Label for="group-listed">Show in public group lists</Label>
						{#if !group.linked.meta.public}
							<span class="text-base-600 dark:text-base-400 text-sm">
								Only a public group can be in them.
							</span>
						{/if}
					</div>
				{/if}
				{#if group.linked.can.post && data.upcomingEvents.length > 0}
					<ul class="space-y-2 text-sm" aria-label="Edit events">
						{#each data.upcomingEvents as event (event.uri)}
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
				{@render managedAtHost()}
				{#if group.linked.reapprove}
					<form method="POST" action="/oauth/group/link" class="flex flex-wrap items-center gap-3">
						<input type="hidden" name="group" value={group.did} />
						<span class="text-base-600 dark:text-base-400 text-sm">
							Your link was approved before atmo asked for all it can do for a group.
						</span>
						<Button type="submit" size="sm" variant="secondary">Approve again</Button>
					</form>
				{/if}
			</section>
		{:else if group.linked}
			<div class="mb-10 flex flex-wrap items-center gap-3">
				<p class="text-base-600 dark:text-base-400 text-sm" role="status">
					Your role in this group lets you see it here, but not post its events or list it.
				</p>
				<Button variant="ghost" disabled={busy} onclick={unlink}>Unlink</Button>
			</div>
		{:else if group.atHost && data.signedIn && !group.unreachable}
			<div class="mb-10 flex flex-wrap items-center gap-3">
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
			<div class="mb-10">
				<Button variant="ghost" disabled={busy} onclick={unlink}>Unlink</Button>
			</div>
		{/if}

		<HappeningNow
			events={data.ongoingEvents}
			total={data.ongoingTotal}
			totalIsFloor={data.ongoingTotalIsFloor}
			actor={group.did}
			seeAllHref={resolve('/(app)/p/[actor]/hosting', { actor: group.did })}
			sectionClass="mb-10"
			gridClass="space-y-5"
		/>

		{#if data.upcomingEvents.length > 0}
			<HostEventsSection
				heading="Upcoming Events"
				events={data.upcomingEvents}
				actor={group.did}
				seeAllHref={data.hasMoreUpcoming
					? resolve('/(app)/p/[actor]/hosting', { actor: group.did })
					: null}
			/>
		{/if}

		{#if data.pastEvents.length > 0}
			<HostEventsSection
				heading="Past Events"
				events={data.pastEvents}
				actor={group.did}
				seeAllHref={data.hasMorePast
					? resolve('/(app)/p/[actor]/past-events', { actor: group.did })
					: null}
			/>
		{/if}

		{#if !hasEvents}
			<div
				class="border-base-200 dark:border-base-800 bg-base-100 dark:bg-base-950/50 mb-10 rounded-2xl border p-8 text-center"
			>
				<p class="text-base-600 dark:text-base-400 py-12 text-center">
					This group hasn't posted any events yet.
				</p>
			</div>
		{/if}
	</div>
</div>

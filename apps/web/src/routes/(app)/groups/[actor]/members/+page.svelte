<script lang="ts">
	import { Avatar, Badge, Button } from '@atmo-dev/kit';
	import { isHttpError } from '@sveltejs/kit';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import GroupAccessNotice from '#lib/groups/components/GroupAccessNotice.svelte';
	import {
		approveRequest,
		changeRole,
		denyRequest,
		removeFromGroup
	} from '#lib/groups/members.remote.js';
	import { isAdmin, shownRoles, type RosterEntry } from '#lib/groups/roster.js';

	let { data } = $props();

	let busy = $state(false);
	let failure: string | null = $state(null);

	const label = (entry: { did: string; handle: string | null }) =>
		entry.handle ? `@${entry.handle}` : entry.did;

	/** A refusal the host gave comes back in words to show; anything else is generic. */
	async function act(run: () => Promise<unknown>) {
		busy = true;
		failure = null;
		try {
			await run();
			await invalidateAll();
		} catch (e) {
			failure =
				isHttpError(e, 400) || isHttpError(e, 403) || isHttpError(e, 409)
					? e.body.message
					: 'That did not work. Try again.';
		} finally {
			busy = false;
		}
	}
</script>

{#snippet member(entry: RosterEntry, muted: boolean)}
	<li class="flex flex-wrap items-center gap-3">
		<Avatar name={label(entry)} size={32} />
		<a
			href={resolve('/(app)/p/[actor]', { actor: entry.did })}
			class="{muted
				? 'text-base-600 dark:text-base-400'
				: 'text-base-900 dark:text-base-50'} min-w-0 flex-1 truncate">{label(entry)}</a
		>
		{#if data.state === 'roster'}
			{#each shownRoles(entry, data.roles) as role (role.id)}<Badge>{role.name}</Badge>{/each}
			{#if entry.did !== data.you}
				{#if data.manage.assign}
					<Button
						size="sm"
						variant="secondary"
						disabled={busy}
						onclick={() =>
							act(() =>
								changeRole({
									groupDid: data.group.did,
									did: entry.did,
									admin: !isAdmin(entry.roles)
								})
							)}>{isAdmin(entry.roles) ? 'Make member' : 'Make admin'}</Button
					>
				{/if}
				{#if data.manage.remove}
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onclick={() => act(() => removeFromGroup({ groupDid: data.group.did, did: entry.did }))}
						>Remove</Button
					>
				{/if}
			{/if}
		{/if}
	</li>
{/snippet}

<div class="min-h-screen px-6 py-12 sm:py-12">
	<div class="mx-auto max-w-2xl">
		<div class="mb-6">
			<a
				href={resolve('/(app)/groups/[actor]', { actor: data.group.did })}
				class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 text-sm font-medium transition-colors"
			>
				&larr; {data.group.name}
			</a>
		</div>

		<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">Members</h1>

		{#if data.state === 'access' && data.you}
			<GroupAccessNotice
				kind="participate"
				access={data.access}
				did={data.you}
				purpose="To see who is in this group, atmo asks your server to act for you in groups."
				spacesServer={data.spacesServer}
			/>
		{:else if data.state === 'hidden'}
			<p class="text-base-600 dark:text-base-400 mt-6">{data.message}</p>
		{:else if data.state === 'roster'}
			{#if isAdmin(data.yours)}<p class="text-base-600 dark:text-base-400 mt-2 text-sm">
					You are an admin.
				</p>{/if}
			{#if failure}<p role="alert" class="text-base-950 dark:text-base-50 mt-4 text-sm">
					{failure}
				</p>{/if}

			{#if data.reapprove}
				<form
					method="POST"
					action="/oauth/group/link"
					class="mt-4 flex flex-wrap items-center gap-3"
				>
					<input type="hidden" name="group" value={data.group.did} />
					<span class="text-base-600 dark:text-base-400 text-sm">
						Your link to this group was approved before atmo could admit and remove members. Approve
						it again at the group host to do that here.
					</span>
					<Button type="submit" size="sm" variant="secondary">Approve again</Button>
				</form>
			{/if}

			{#if data.manage.admit}
				<h2 class="text-base-900 dark:text-base-50 mt-8 text-lg font-semibold">Asking to join</h2>
				{#if data.requests === null}
					<p class="text-base-600 dark:text-base-400 mt-2 text-sm" role="status">
						The requests could not be read right now. Try again shortly.
					</p>
				{:else if data.requests.length === 0}
					<p class="text-base-600 dark:text-base-400 mt-2 text-sm">Nobody is waiting.</p>
				{:else}
					<ul class="mt-4 space-y-3" aria-label="Asking to join">
						{#each data.requests as request (request.did)}
							<li class="flex flex-wrap items-center gap-3">
								<Avatar name={label(request)} size={32} />
								<span class="min-w-0 flex-1">
									<a
										href={resolve('/(app)/p/[actor]', { actor: request.did })}
										class="text-base-900 dark:text-base-50 block truncate">{label(request)}</a
									>
									{#if request.message}<span
											class="text-base-600 dark:text-base-400 block text-sm whitespace-pre-line"
											>{request.message}</span
										>{/if}
								</span>
								<Button
									size="sm"
									disabled={busy}
									onclick={() =>
										act(() => approveRequest({ groupDid: data.group.did, did: request.did }))}
									>Approve</Button
								>
								<Button
									size="sm"
									variant="ghost"
									disabled={busy}
									onclick={() =>
										act(() => denyRequest({ groupDid: data.group.did, did: request.did }))}
									>Deny</Button
								>
							</li>
						{/each}
					</ul>
				{/if}
			{/if}

			<ul class="mt-8 space-y-2" aria-label="Members">
				{#each data.listed as entry (entry.did)}
					{@render member(entry, false)}
				{/each}
			</ul>

			{#if data.unconfirmed.length > 0}
				<h2 class="text-base-900 dark:text-base-50 mt-10 text-lg font-semibold">
					Not confirmed yet
				</h2>
				<p class="text-base-600 dark:text-base-400 text-sm">
					Admitted, but their own server has not confirmed it yet: they have not been back to the
					group's page to confirm it, or their server has no spaces support. Only those who can
					admit members see them.
				</p>
				<ul class="mt-4 space-y-2" aria-label="Not confirmed yet">
					{#each data.unconfirmed as entry (entry.did)}
						{@render member(entry, true)}
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</div>

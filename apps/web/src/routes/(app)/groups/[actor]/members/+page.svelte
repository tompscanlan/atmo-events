<script lang="ts">
	import { Avatar, Badge, Button, Input, Label, Select } from '@atmo-dev/kit';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { requestPermissions } from '@svelte-atproto/oauth/client';
	import {
		addMember,
		approveRequest,
		changeRole,
		denyRequest,
		remove
	} from '#lib/groups/members.remote.js';
	import { GROUP_ROLES } from '#lib/groups/permissions.js';
	import { GROUP_PERSON_SCOPES } from '#lib/groups/scopes.js';

	let { data } = $props();

	let busy = $state(false);
	let failure: string | null = $state(null);
	let newMember = $state('');
	let newRole = $state<string>('member');

	const label = (did: string) => (data.hidden ? did : (data.handles[did] ?? did));
	const asRole = (value: string) => value as (typeof GROUP_ROLES)[number];

	/** A refusal the host gave comes back in words to show; anything else is generic. */
	async function act(run: () => Promise<unknown>) {
		busy = true;
		failure = null;
		try {
			await run();
			await invalidateAll();
		} catch (e) {
			const message = (e as { body?: { message?: unknown } })?.body?.message;
			failure =
				typeof message === 'string' && (e as { status?: number }).status === 409
					? message
					: 'That did not work. Try again, or link the group again.';
		} finally {
			busy = false;
		}
	}
</script>

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

		{#if data.needsAccess}
			<p class="text-muted mt-6">
				To see who is in this group, allow atmo to read the groups you belong to.
			</p>
			{#if failure}<p role="alert" class="mt-4 text-sm text-red-600">{failure}</p>{/if}
			<div class="mt-4">
				<Button
					variant="secondary"
					disabled={busy}
					onclick={() => act(() => requestPermissions(GROUP_PERSON_SCOPES))}>See your groups</Button
				>
			</div>
			<p class="text-muted mt-4 text-sm">
				This needs a server with spaces support, the part of atproto that keeps a group's members
				private, and most servers do not have it yet.
				{#if data.spacesServer}
					You can make an account at
					<!-- Another site's address, from this site's settings, so there is nothing to resolve. -->
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<a
						href={data.spacesServer.url}
						rel="external noopener"
						class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 font-medium"
						>{data.spacesServer.host}</a
					><!-- eslint-enable svelte/no-navigation-without-resolve -->, which does, and sign in to
					atmo with it.
				{/if}
			</p>
		{:else if data.hidden}
			<p class="text-muted mt-6">Only members can see who is in this group.</p>
		{:else}
			{#if data.role}<p class="text-muted mt-2 text-sm">You are a {data.role}.</p>{/if}
			{#if failure}<p role="alert" class="mt-4 text-sm text-red-600">{failure}</p>{/if}

			{#if data.requests && data.requests.length > 0}
				<h2 class="text-base-900 dark:text-base-50 mt-8 text-lg font-semibold">Asking to join</h2>
				<ul class="mt-4 space-y-3">
					{#each data.requests as request (request.did)}
						<li class="flex flex-wrap items-center gap-3">
							<Avatar name={label(request.did)} size={32} />
							<span class="min-w-0 flex-1">
								<span class="text-base-900 dark:text-base-50 block truncate"
									>{label(request.did)}</span
								>
								{#if request.message}<span class="text-muted block text-sm">{request.message}</span
									>{/if}
							</span>
							<Button
								size="sm"
								disabled={busy}
								onclick={() =>
									act(() =>
										approveRequest({ groupDid: data.group.did, did: request.did, role: 'member' })
									)}>Approve</Button
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

			<ul class="mt-6 space-y-2">
				{#each data.listed as entry (entry.did)}
					<li class="flex flex-wrap items-center gap-3">
						<Avatar name={label(entry.did)} size={32} />
						<a
							href={resolve('/(app)/p/[actor]', { actor: entry.did })}
							class="text-base-900 dark:text-base-50 min-w-0 flex-1 truncate">{label(entry.did)}</a
						>
						{#if data.manage.assign && entry.did !== data.you}
							<Select
								aria-label="Role of {label(entry.did)}"
								value={entry.role}
								disabled={busy}
								onchange={(event) =>
									act(() =>
										changeRole({
											groupDid: data.group.did,
											did: entry.did,
											role: asRole(event.currentTarget.value)
										})
									)}
							>
								{#each GROUP_ROLES as role (role)}<option value={role}>{role}</option>{/each}
							</Select>
						{:else if entry.role !== 'member'}
							<Badge>{entry.role}</Badge>
						{/if}
						{#if data.manage.eject && entry.did !== data.you}
							<Button
								size="sm"
								variant="ghost"
								disabled={busy}
								onclick={() => act(() => remove({ groupDid: data.group.did, did: entry.did }))}
								>Remove</Button
							>
						{/if}
					</li>
				{/each}
			</ul>

			{#if data.unconfirmed.length > 0}
				<h2 class="text-base-900 dark:text-base-50 mt-10 text-lg font-semibold">
					Not confirmed yet
				</h2>
				<p class="text-muted text-sm">
					Added, but they have not visited the group since. Only people who can admit members see
					this list.
				</p>
				<ul class="mt-4 space-y-2">
					{#each data.unconfirmed as entry (entry.did)}
						<li class="flex items-center gap-3">
							<Avatar name={label(entry.did)} size={32} />
							<span class="text-muted min-w-0 flex-1 truncate">{label(entry.did)}</span>
							{#if entry.role !== 'member'}<Badge>{entry.role}</Badge>{/if}
						</li>
					{/each}
				</ul>
			{/if}

			{#if data.manage.admit}
				<form
					class="mt-10 flex flex-wrap items-end gap-2"
					onsubmit={(event) => {
						event.preventDefault();
						act(async () => {
							await addMember({
								groupDid: data.group.did,
								actor: newMember,
								role: asRole(newRole)
							});
							newMember = '';
						});
					}}
				>
					<div class="min-w-0 flex-1">
						<Label for="add-member">Add someone by handle</Label>
						<Input id="add-member" bind:value={newMember} placeholder="name.example.com" required />
					</div>
					<Select aria-label="Their role" bind:value={newRole}>
						{#each GROUP_ROLES as role (role)}<option value={role}>{role}</option>{/each}
					</Select>
					<Button type="submit" variant="secondary" disabled={busy}>Add</Button>
				</form>
			{:else if !data.linked && data.role === 'admin'}
				<p class="text-muted mt-10 text-sm">
					To admit, remove or change members here, link the group from its page.
				</p>
			{/if}
		{/if}
	</div>
</div>

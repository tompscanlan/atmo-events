<script lang="ts">
	import { AvatarGroup, Badge, Button, Input, Label } from '@foxui/core';
	import {
		approveJoinRequestForm,
		joinGroupForm,
		leaveGroupForm,
		rejectJoinRequestForm,
		repairGroupForm,
		updateGroupForm
	} from '$lib/groups/groups.remote';
	import { groupFormError, resetOnSuccess } from '$lib/groups/form-result';

	import PdslsLink from '$lib/groups/components/PdslsLink.svelte';
	import GroupMonogram from '$lib/groups/components/GroupMonogram.svelte';
	import PersonLabel from '$lib/groups/components/PersonLabel.svelte';
	import { resolve } from '$app/paths';
	import { reauthorize } from '$lib/atproto/auth.svelte';

	let { data } = $props();

	let group = $derived(data.group);
	// Name, description, location and rules come from the about-space records,
	// with the cache as fallback; `data.about.source` says which.
	let about = $derived(data.about);
	let membership = $derived(data.membership);
	let isOwner = $derived(membership.role === 'owner');
	let isMember = $derived(membership.role !== null);
	let isPending = $derived(membership.pendingRequestId !== null);
	// What the group published, not what our columns imply. `joinPolicy` is the
	// profile record's own field for a public group, and invite-only for any
	// other: the loader derives it from the host's visibility (`groupFace`), and
	// from `require_approval` only when there is no record to read. Reading the
	// columns here would let the page contradict the group's host.
	let joinPolicy = $derived(about.joinPolicy);
	let joiningLabel = $derived(
		joinPolicy === 'open'
			? 'open to anyone'
			: joinPolicy === 'approval'
				? 'by approval'
				: 'invite only'
	);
	// The server still decides: a private group refuses a self-service join,
	// and the refusal comes back as the form error below. The label only
	// describes what pressing the button asks for.
	let joinLabel = $derived(
		joinPolicy === 'open'
			? 'Join'
			: joinPolicy === 'approval'
				? 'Request to join'
				: 'Ask to be invited'
	);
	let joinError = $derived(groupFormError(joinGroupForm.result));
	let joinPending = $derived(
		joinGroupForm.result?.ok === true && joinGroupForm.result.outcome === 'pending'
	);
	// A join or request comes back with an authorize URL when the member's session
	// should pick up this group's grant. The join already stands either way.
	$effect(() => {
		const result = joinGroupForm.result;
		if (result?.ok === true && result.reauthorize) reauthorize(result.reauthorize);
	});
	let leaveError = $derived(groupFormError(leaveGroupForm.result));
	let settingsError = $derived(groupFormError(updateGroupForm.result));
	let repairError = $derived(groupFormError(repairGroupForm.result));
	let repairSummary = $derived(
		repairGroupForm.result?.ok === true ? repairGroupForm.result.summary : undefined
	);
	let showSettings = $state(false);
	// The group's visibility as its host reports it: the about space's read
	// policy. Null when the host could not be asked, and then no badge shows.
	let visibility = $derived(data.visibility);
	// The visibility currently selected in the settings form, or null for "not
	// changed yet", in which case the host's applies. A private group is
	// invite-only and a save refuses one that does not require approval, so the
	// form shows approval as fixed on while private is picked.
	let pickedVisibility = $state<string | null>(null);
	let settingsPrivate = $derived((pickedVisibility ?? visibility) === 'private');
</script>

<svelte:head>
	<title>{about.name} - atmo.rsvp</title>
	<meta name="description" content={about.description ?? `${about.name} on atmo.rsvp`} />
</svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	<a
		href={resolve('/groups')}
		class="text-base-500 dark:text-base-400 mb-6 inline-block text-sm hover:underline"
		>← All groups</a
	>

	<header class="flex items-start gap-4">
		<GroupMonogram name={about.name} class="size-16 text-2xl" />
		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
				<h1 class="text-3xl font-bold sm:text-4xl">{about.name}</h1>
				{#if visibility}<Badge variant="secondary">{visibility}</Badge>{/if}
				{#if membership.role}<Badge>{membership.role}</Badge>{/if}
			</div>
			<!-- The group's address, shown as the handle when its PDS confirms one.
			     A person can read, say and type a handle, so it belongs on the page.
			     The app does not link with it, because a handle can lapse and be
			     registered by another account, while the DID never moves. So the
			     text and the URL differ on purpose: the readable name here, the
			     permanent key in every href. -->
			<PdslsLink
				to={group.group_did}
				title="The group's account on pds.ls"
				class="text-base-500 dark:text-base-400 mt-1 inline-block font-mono text-sm break-all hover:underline"
				>{data.handle ? `@${data.handle}` : group.group_did}</PdslsLink
			>
		</div>
	</header>

	{#if about.description}
		<p class="text-base-700 dark:text-base-200 mt-6 whitespace-pre-line">{about.description}</p>
	{/if}

	<div class="mt-6 grid gap-3 sm:grid-cols-3">
		<div class="ring-base-200 dark:ring-base-800 rounded-2xl p-4 ring-1">
			<p class="text-base-500 dark:text-base-400 text-xs font-medium uppercase">Members</p>
			<p class="mt-1 text-2xl font-semibold">{data.memberCount}</p>
			{#if data.rosterPreview.length > 0}
				<a
					href={resolve('/(app)/groups/[actor]/members', { actor: group.group_did })}
					class="mt-2 inline-block"
					title="See every member"
				>
					<AvatarGroup
						users={data.rosterPreview.map((entry) => ({
							src: data.people[entry.did]?.avatar ?? undefined,
							alt: data.people[entry.did]?.handle ?? entry.did
						}))}
						avatarClass="size-7"
					/>
				</a>
			{/if}
		</div>
		<div class="ring-base-200 dark:ring-base-800 rounded-2xl p-4 ring-1">
			<p class="text-base-500 dark:text-base-400 text-xs font-medium uppercase">Joining</p>
			<p class="mt-1 font-semibold">{joiningLabel}</p>
		</div>
		{#if about.locationName}
			<div class="ring-base-200 dark:ring-base-800 rounded-2xl p-4 ring-1">
				<p class="text-base-500 dark:text-base-400 text-xs font-medium uppercase">Where</p>
				<p class="mt-1 font-semibold">{about.locationName}</p>
			</div>
		{/if}
	</div>

	{#if data.ownerDid}
		<div class="mt-4 flex items-center gap-3 text-sm">
			<span class="text-base-500 dark:text-base-400">Organized by</span>
			<PersonLabel did={data.ownerDid} person={data.people[data.ownerDid]} size="sm" />
		</div>
	{/if}

	<div class="mt-8 flex flex-wrap items-center gap-3">
		<!-- Both links carry the group's DID, so a page reached through a handle
		     URL still hands out DID links. -->
		<Button
			href={resolve('/(app)/groups/[actor]/events', { actor: group.group_did })}
			variant="secondary">Events</Button
		>
		{#if data.canSeeMembers}
			<Button
				href={resolve('/(app)/groups/[actor]/members', { actor: group.group_did })}
				variant="secondary">Members</Button
			>
		{/if}

		{#if !data.membership.did}
			<a href={resolve('/login')} class="text-accent-600 dark:text-accent-400 text-sm underline"
				>Sign in to join</a
			>
		{:else if isPending}
			<form {...resetOnSuccess(leaveGroupForm)}>
				<input type="hidden" name="groupDid" value={group.group_did} />
				<Button type="submit" variant="ghost">Withdraw request</Button>
			</form>
			<span class="text-base-500 dark:text-base-400 text-sm">Request pending approval</span>
		{:else if isMember}
			{#if isOwner}
				<span class="text-base-500 dark:text-base-400 text-sm"
					>You own this group and cannot leave it.</span
				>
			{:else}
				<form {...resetOnSuccess(leaveGroupForm)}>
					<input type="hidden" name="groupDid" value={group.group_did} />
					<Button type="submit" variant="ghost">Leave group</Button>
				</form>
			{/if}
		{:else}
			<form {...resetOnSuccess(joinGroupForm)} class="flex items-center gap-2">
				<input type="hidden" name="groupDid" value={group.group_did} />
				<Input name="message" placeholder="Say hello (optional)" class="w-56" />
				<Button type="submit">{joinLabel}</Button>
			</form>
		{/if}
	</div>

	{#if joinError}
		<p class="mt-3 text-sm text-red-600 dark:text-red-400">{joinError}</p>
	{:else if joinPending}
		<p class="text-base-500 dark:text-base-400 mt-3 text-sm">
			Request sent. An admin has to approve it.
		</p>
	{/if}
	{#if leaveError}
		<p class="mt-3 text-sm text-red-600 dark:text-red-400">{leaveError}</p>
	{/if}

	{#if about.rules.length > 0}
		<section class="ring-base-200 dark:ring-base-800 mt-10 rounded-2xl p-5 ring-1">
			<h2 class="text-lg font-semibold">Group rules</h2>
			<!-- One record per rule, so each has a URI a moderation action can
			     cite. Rendered in the records' own `order`. -->
			<ol class="text-base-700 dark:text-base-200 mt-3 list-decimal space-y-2 pl-6 text-sm">
				{#each about.rules as rule (rule.uri)}
					<li>{rule.text}</li>
				{/each}
			</ol>
		</section>
	{/if}

	{#if data.canAdmitMembers && data.pendingRequests.length > 0}
		<section class="mt-10">
			<h2 class="mb-3 text-xl font-semibold">
				Join requests ({data.pendingRequests.length})
			</h2>
			<ul class="flex flex-col gap-2">
				{#each data.pendingRequests as request (request.id)}
					<!-- One form instance per row: a remote form object attaches to one
					     `<form>` only. -->
					{@const approveForm = approveJoinRequestForm.for(request.id)}
					{@const rejectForm = rejectJoinRequestForm.for(request.id)}
					{@const requestError =
						groupFormError(approveForm.result) ?? groupFormError(rejectForm.result)}
					<li
						class="ring-base-200 dark:ring-base-800 flex flex-wrap items-center justify-between gap-3 rounded-xl p-3 ring-1"
					>
						<div class="min-w-0">
							<PersonLabel did={request.did} person={data.people[request.did]} />
							{#if request.message}
								<p class="text-base-500 dark:text-base-400 mt-2 text-sm">{request.message}</p>
							{/if}
						</div>
						<div class="flex shrink-0 gap-2">
							<form {...resetOnSuccess(approveForm)}>
								<input type="hidden" name="groupDid" value={group.group_did} />
								<input type="hidden" name="requestId" value={request.id} />
								<input type="hidden" name="role" value="member" />
								<Button type="submit" size="sm">Approve</Button>
							</form>
							<form {...resetOnSuccess(rejectForm)}>
								<input type="hidden" name="groupDid" value={group.group_did} />
								<input type="hidden" name="requestId" value={request.id} />
								<Button type="submit" size="sm" variant="ghost">Reject</Button>
							</form>
						</div>
						{#if requestError}
							<p class="w-full text-sm text-red-600 dark:text-red-400">{requestError}</p>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<!-- Where the page's data came from, with each piece openable on pds.ls. -->
	<details class="ring-base-200 dark:ring-base-800 mt-10 rounded-2xl p-4 ring-1">
		<summary class="cursor-pointer text-sm font-semibold">Where this group's data lives</summary>
		<p class="text-base-500 dark:text-base-400 mt-3 text-xs">
			{about.source === 'records'
				? 'Name, description and rules read from this group’s about space.'
				: 'Reading from cache. This group has no profile record yet.'}
			Each link opens on pds.ls. A space opens there only when you are signed in to pds.ls with an account
			it admits.
		</p>
		<dl class="mt-4 flex flex-col gap-3 text-sm">
			<div>
				<dt class="text-base-500 dark:text-base-400 text-xs">Group account</dt>
				<dd>
					<PdslsLink
						to={group.group_did}
						class="text-accent-600 dark:text-accent-400 font-mono text-xs break-all hover:underline"
						>{group.group_did}</PdslsLink
					>
				</dd>
			</div>
			{#if group.about_space_uri}
				<div>
					<dt class="text-base-500 dark:text-base-400 text-xs">About space: profile and rules</dt>
					<dd>
						<PdslsLink
							to={group.about_space_uri}
							class="text-accent-600 dark:text-accent-400 font-mono text-xs break-all hover:underline"
							>{group.about_space_uri}</PdslsLink
						>
					</dd>
				</div>
			{/if}
			{#if group.members_space_uri}
				<div>
					<dt class="text-base-500 dark:text-base-400 text-xs">
						Members space: memberships, roles and permissions
					</dt>
					<dd>
						<PdslsLink
							to={group.members_space_uri}
							class="text-accent-600 dark:text-accent-400 font-mono text-xs break-all hover:underline"
							>{group.members_space_uri}</PdslsLink
						>
					</dd>
				</div>
			{/if}
		</dl>
		{#if about.rules.length > 0}
			<p class="text-base-500 dark:text-base-400 mt-4 text-xs">Rule records:</p>
			<ol class="mt-1 flex flex-col gap-1">
				{#each about.rules as rule, index (rule.uri)}
					<li>
						<PdslsLink
							to={rule.uri}
							class="text-accent-600 dark:text-accent-400 font-mono text-xs break-all hover:underline"
							>{index + 1}. {rule.uri}</PdslsLink
						>
					</li>
				{/each}
			</ol>
		{/if}
	</details>

	<!-- Outside the settings toggle: until the owner links, every write as the
	     group fails, so the one step that fixes it is not left folded away. -->
	{#if data.groupLinked === false}
		<form
			method="POST"
			action="/oauth/group-link"
			class="mt-10 rounded-2xl p-4 text-sm ring-1 ring-amber-500/40"
		>
			<input type="hidden" name="groupDid" value={group.group_did} />
			<p class="font-semibold">Link this group's account</p>
			<p class="mt-1">
				This site cannot write as the group until you do, so its events, settings and member changes
				wait on it. At the group's PDS you sign in as the group, not as yourself, with the email and
				password you chose when you created it, and approve this site.
			</p>
			<div class="mt-3"><Button type="submit">Link the group's account</Button></div>
		</form>
	{/if}

	{#if data.canManageGroup}
		<section class="mt-10">
			<button
				type="button"
				class="text-base-500 dark:text-base-400 text-sm hover:underline"
				onclick={() => {
					showSettings = !showSettings;
					pickedVisibility = null;
				}}
			>
				{showSettings ? 'Hide' : 'Show'} group settings
			</button>

			{#if data.linkOutcome === 'linked'}
				<p class="text-base-500 dark:text-base-400 mt-3 text-sm">
					Linked. This site now writes as the group through the session you authorized.
				</p>
			{:else if data.linkOutcome === 'failed'}
				<p class="mt-3 text-sm text-red-600 dark:text-red-400">
					The link did not complete, and nothing changed. At the group's PDS, sign in as the group
					itself, not as yourself, and approve the request.
				</p>
			{/if}

			{#if showSettings}
				<form {...resetOnSuccess(updateGroupForm)} class="mt-4 flex flex-col gap-4">
					<input type="hidden" name="groupDid" value={group.group_did} />
					<!-- The visibility this form shows, which is the host's as the page
					     read it, and empty when the host could not be read. The save
					     moves the visibility only when the choice below differs from
					     it, so a tab opened before someone else changed the visibility
					     does not change it back. A hidden input's value is its default,
					     so a reset keeps it, and a reload after a save refreshes it. -->
					<input type="hidden" name="shownVisibility" value={visibility ?? ''} />
					<!-- Default values, not values. A successful remote-form submission
					     resets the form, and a reset restores each control's default
					     (`defaultValue` / `defaultChecked`), not the `value` property
					     Svelte assigns. With `value=`, `description` and `rules` come
					     back empty after a save, so the next save would write an empty
					     description and delete every rule record. `<select>` is fine:
					     its `selected` attribute is the option's default. -->
					<div class="flex flex-col gap-1.5">
						<Label for="settings-name">Name</Label>
						<Input id="settings-name" name="name" defaultValue={about.name} required />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="settings-description">Description</Label>
						<textarea
							id="settings-description"
							name="description"
							rows="3"
							defaultValue={about.description ?? ''}
							class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
						></textarea>
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="settings-rules">Rules</Label>
						<textarea
							id="settings-rules"
							name="rules"
							rows="4"
							placeholder="One rule per line"
							defaultValue={about.rules.map((rule) => rule.text).join('\n')}
							class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
						></textarea>
						<p class="text-base-500 dark:text-base-400 text-xs">
							One rule per line. Each line is its own record, so editing one rule leaves the others’
							addresses untouched.
						</p>
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="settings-visibility">Visibility</Label>
						<select
							id="settings-visibility"
							name="visibility"
							required
							onchange={(e) => (pickedVisibility = e.currentTarget.value)}
							class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
						>
							<!-- The host did not say. No option is preselected then, because a
							     save would otherwise send the first one and could move the group
							     to it; the owner has to pick one. -->
							{#if visibility === null}
								<option value="" disabled selected>could not be read from its PDS</option>
							{/if}
							{#each ['public', 'private'] as value (value)}
								<option {value} selected={visibility === value}>{value}</option>
							{/each}
						</select>
					</div>
					<!-- No space URI field: both spaces are created with the group under
					     its own DID, so there is nothing to edit. They are listed,
					     read-only, under "Where this group's data lives". -->
					<!-- A disabled checkbox is never submitted, and an absent checkbox
					     parses as "off", so the fixed-on case sends its value through a
					     hidden input. -->
					{#if settingsPrivate}
						<input type="hidden" name="requireApproval" value="on" />
						<label class="flex items-center gap-2 text-sm">
							<input type="checkbox" checked disabled class="size-4" />
							Require approval to join
						</label>
						<p class="text-base-500 dark:text-base-400 -mt-2 text-xs">
							A private group is invite-only, so approval is always on.
						</p>
					{:else}
						<label class="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								name="requireApproval"
								defaultChecked={!!group.require_approval}
								class="size-4"
							/>
							Require approval to join
						</label>
					{/if}
					{#if settingsError}
						<p class="text-sm text-red-600 dark:text-red-400">{settingsError}</p>
					{:else if updateGroupForm.result?.ok}
						<p class="text-base-500 dark:text-base-400 text-sm">Saved.</p>
					{/if}
					<div><Button type="submit">Save settings</Button></div>
				</form>

				<!-- A separate form, so repairing never submits the settings above. -->
				<form
					{...resetOnSuccess(repairGroupForm)}
					class="border-base-200 dark:border-base-800 mt-8 flex flex-col gap-2 border-t pt-6"
				>
					<input type="hidden" name="groupDid" value={group.group_did} />
					<h3 class="text-sm font-semibold">Repair this group</h3>
					<p class="text-base-500 dark:text-base-400 text-xs">
						Writes any of this group's member records that are missing and can be written safely,
						brings the group's member list at its PDS in line with those records, publishes or
						withdraws its declaration to match the visibility its PDS enforces, then rebuilds this
						site's copy of the group from its records. It never overwrites a record that exists, and
						running it twice changes nothing the second time.
					</p>
					{#if repairError}
						<p class="text-sm text-red-600 dark:text-red-400">{repairError}</p>
					{:else if repairSummary}
						<p class="text-base-500 dark:text-base-400 text-sm">{repairSummary}</p>
					{/if}
					<div><Button type="submit" variant="secondary">Repair this group</Button></div>
				</form>

				{#if data.groupLinked}
					<!-- A plain post, not a remote form: the answer is a redirect to the
					     group's PDS. Only the owner sees it, and only the owner may link. An
					     unlinked group's prompt sits above the settings. -->
					<form
						method="POST"
						action="/oauth/group-link"
						class="border-base-200 dark:border-base-800 mt-8 flex flex-col gap-2 border-t pt-6"
					>
						<input type="hidden" name="groupDid" value={group.group_did} />
						<h3 class="text-sm font-semibold">This group's account</h3>
						<p class="text-base-500 dark:text-base-400 text-xs">
							This site writes as the group through a session you authorized at the group's PDS.
							Reconnect if you revoked it there or it stopped working.
						</p>
						<div>
							<Button type="submit" variant="secondary">Reconnect the group's account</Button>
						</div>
					</form>
				{/if}
			{/if}
		</section>
	{/if}
</div>

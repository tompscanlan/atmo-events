<script lang="ts">
	import { Button, Input, Label } from '@foxui/core';
	import { createGroupForm } from '$lib/groups/groups.remote';
	import { resolve } from '$app/paths';
	import { MINTABLE_LABEL_INPUT_PATTERN, slugifyGroupName } from '$lib/groups/slug';
	import { groupFormError } from '$lib/groups/form-result';

	let { data } = $props();

	let name = $state('');
	let slug = $state('');
	// The slug follows the name until the operator edits it, then stops — typing a
	// URL by hand and watching it be overwritten is the worse failure.
	let slugTouched = $state(false);
	let derivedSlug = $derived(slugTouched ? slug : name ? slugifyGroupName(name) : '');
	let createError = $derived(groupFormError(createGroupForm.result));
	// The success branch carries the recovery key, so it is read ONCE from the
	// form result and never refetched — there is no route that could show it
	// again, which is the point.
	let created = $derived.by(() => {
		const result = createGroupForm.result;
		return result && result.ok ? result : undefined;
	});
</script>

<svelte:head><title>New group — atmo.rsvp</title></svelte:head>

<div class="mx-auto max-w-2xl px-6 py-8 sm:py-12">
	<h1 class="mb-2 text-3xl font-bold">New group</h1>
	<p class="text-base-500 dark:text-base-400 mb-4 text-sm">
		A group is an account on the network. Creating one registers a new identity — its address
		becomes its handle, so the name has to be free.
	</p>
	<!-- Groups are hosted one way for now — OpenMeet holds the account — so the
	     page says which way rather than leaving it to be inferred. The earlier
	     copy named only what the owner gets (the recovery key) and never what we
	     keep (the writing credential, and the account's email address), which
	     reads as ownership to anyone who does not already know atproto.
	     (Spec: FR-001i.) -->
	<p class="text-base-500 dark:text-base-400 mb-8 text-sm">
		<strong>OpenMeet hosts this group for you.</strong> We hold the credential the group posts
		with, and its account email is ours, so we can keep it working and help when it breaks — you do
		not need to know anything about atproto to run a group here. What you get at the end is its
		<strong>recovery key</strong>: with it you can move the group to a host of your own later, and
		nobody — including us — can stop you. Owning the group's account outright is not offered yet.
	</p>

	{#if !data.mintConfigured}
		<div
			class="ring-base-200 dark:ring-base-800 text-base-600 dark:text-base-300 mb-8 rounded-2xl p-4 text-sm ring-1"
		>
			<p class="font-semibold">Group creation is not configured on this deployment.</p>
			<p class="mt-1">
				An administrator needs to set <code class="font-mono">GROUP_PDS_SERVICE</code>,
				<code class="font-mono">GROUP_HANDLE_DOMAIN</code>,
				<code class="font-mono">GROUP_PDS_INVITE_CODE</code>,
				<code class="font-mono">GROUP_ACCOUNT_EMAIL</code> and
				<code class="font-mono">GROUP_CREDENTIAL_KEY</code> first.
			</p>
		</div>
	{/if}

	<!-- Shown ONCE. The private key is never stored by us and cannot be shown
	     again; it is what lets the owner move the group off this PDS without our
	     cooperation, because it is the first PLC rotation key on the account.
	     (Spec: FR-001g.) -->
	{#if created}
		<div class="mb-8 rounded-2xl p-4 text-sm ring-1 ring-amber-500/40">
			<p class="font-semibold">Save your group's recovery key now.</p>
			<p class="mt-1">
				This is the only time it is shown. It is not stored anywhere on this service. Keep it
				somewhere safe — with it you can move
				<strong>{created.groupSlug}</strong> to another host, and without it you cannot.
			</p>
			<!-- The key is portability, not ownership: it moves the group, it does
			     not operate it. Saying only what it unlocks invites the reading
			     that it is the group's password. (Spec: FR-001i.) -->
			<p class="mt-1">
				It is <em>not</em> the group's password: it will not sign you in, and it is not needed to
				post, edit or invite. Lose it and the group keeps working — you lose only the ability to
				take it elsewhere without us.
			</p>
			<textarea
				readonly
				rows="2"
				class="rounded-ui bg-base-100 dark:bg-base-900 mt-3 w-full border-0 px-3 py-1.5 font-mono text-xs"
				value={created.recoveryKey}
			></textarea>
			<p class="mt-3">
				<a class="underline" href={resolve('/(app)/groups/[slug]', { slug: created.groupSlug })}
					>Continue to {created.groupSlug}</a
				>
			</p>
		</div>
	{/if}

	<form {...createGroupForm} class="flex flex-col gap-5">
		<div class="flex flex-col gap-1.5">
			<Label for="group-name">Name</Label>
			<Input id="group-name" name="name" bind:value={name} required maxlength={120} />
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="group-slug">URL</Label>
			<div class="flex items-center gap-2">
				<span class="text-base-500 dark:text-base-400 shrink-0 text-sm">/groups/</span>
				<Input
					id="group-slug"
					name="slug"
					value={derivedSlug}
					oninput={(e) => {
						slugTouched = true;
						slug = e.currentTarget.value;
					}}
					required
					pattern={MINTABLE_LABEL_INPUT_PATTERN}
					class="flex-1"
				/>
			</div>
		</div>

		<!-- The Group DID field is gone: creating a group MINTS its identity, so
		     there is no DID to choose and no credential for an operator to
		     pre-provision. (Spec: FR-001; bead om-kp7ss.1.) -->

		<div class="flex flex-col gap-1.5">
			<Label for="group-description">Description</Label>
			<textarea
				id="group-description"
				name="description"
				rows="4"
				maxlength="4000"
				class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
			></textarea>
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="group-rules">Rules</Label>
			<textarea
				id="group-rules"
				name="rules"
				rows="4"
				maxlength="8000"
				placeholder="One rule per line"
				class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
			></textarea>
			<p class="text-base-500 dark:text-base-400 text-xs">
				Optional, and editable later. Each line becomes its own record in the group’s about
				space, so a rule keeps one stable address even as the list changes.
			</p>
		</div>

		<div class="grid gap-5 sm:grid-cols-2">
			<div class="flex flex-col gap-1.5">
				<Label for="group-visibility">Visibility</Label>
				<select
					id="group-visibility"
					name="visibility"
					class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
				>
					<option value="public">public — listed and browsable</option>
					<option value="unlisted">unlisted — reachable by link</option>
					<option value="private">private — members only</option>
				</select>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="group-status">Status</Label>
				<select
					id="group-status"
					name="status"
					class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
				>
					<option value="draft">draft</option>
					<option value="pending">pending</option>
					<option value="published">published</option>
				</select>
			</div>
		</div>

		<!-- The Space URI field is gone: creating a group now CREATES its `about`
		     and `members` spaces on the group's own PDS account, so
		     there is nothing to paste. The URIs appear on the group page. -->

		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" name="requireApproval" checked class="size-4" />
			Require approval to join
		</label>

		{#if createError}
			<p class="text-sm text-red-600 dark:text-red-400">{createError}</p>
		{/if}

		<div>
			<Button type="submit">Create group</Button>
		</div>
	</form>
</div>

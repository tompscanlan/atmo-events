<script lang="ts">
	import { Button, Input, Label } from '@foxui/core';
	import { createGroupForm } from '$lib/groups/groups.remote';
	import { resolve } from '$app/paths';
	import { MINTABLE_LABEL_INPUT_PATTERN, labelFromGroupName } from '$lib/groups/handle-label';
	import { groupFormError } from '$lib/groups/form-result';

	let { data } = $props();

	let name = $state('');
	let label = $state('');
	// The label follows the name until the user edits it, then stops, so a
	// handle typed by hand is never overwritten.
	let labelTouched = $state(false);
	// A private group is invite-only, and the groups table refuses one that does
	// not require approval, so the form shows approval as fixed-on rather than
	// letting the combination be picked and then refused on submit.
	let visibility = $state('public');
	let derivedLabel = $derived(labelTouched ? label : name ? labelFromGroupName(name) : '');
	let createError = $derived(groupFormError(createGroupForm.result));
	// The success branch carries the recovery key, so it is read once from the
	// form result and never fetched again. No route can show it again.
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
	<!-- There is one hosting path for now, so the page names it. The owner gets
	     the recovery key; the site keeps the writing credential and the account
	     email. Saying only the first would read as full ownership. -->
	<p class="text-base-500 dark:text-base-400 mb-8 text-sm">
		<strong>This site hosts the group for you.</strong> We hold the credential the group posts with,
		and its account email is ours, so we can keep it working and help when it breaks. You do not
		need to know anything about atproto to run a group here. What you get at the end is its
		<strong>recovery key</strong>: with it you can move the group to a host of your own later, and
		nobody, including us, can stop you. Owning the group's account outright is not offered yet.
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

	<!-- Shown once. We never store the private key and cannot show it again. It
	     lets the owner move the group off this PDS without our help, because it
	     is the first PLC rotation key on the account. -->
	{#if created}
		<div class="mb-8 rounded-2xl p-4 text-sm ring-1 ring-amber-500/40">
			<p class="font-semibold">Save your group's recovery key now.</p>
			<p class="mt-1">
				This is the only time it is shown. It is not stored anywhere on this service. Keep it
				somewhere safe — with it you can move
				<strong>{created.handle}</strong> to another host, and without it you cannot.
			</p>
			<!-- The key is for moving the group, not for running it. If the page
			     only said what it unlocks, people could take it for the group's
			     password. -->
			<p class="mt-1">
				It is <em>not</em> the group's password: it will not sign you in, and it is not needed to post,
				edit or invite. Lose it and the group keeps working — you lose only the ability to take it elsewhere
				without us.
			</p>
			<textarea
				readonly
				rows="2"
				class="rounded-ui bg-base-100 dark:bg-base-900 mt-3 w-full border-0 px-3 py-1.5 font-mono text-xs"
				value={created.recoveryKey}
			></textarea>
			<!-- The link text is the handle, which the owner just chose and will
			     recognize. The href carries the DID, because that is the group's
			     permanent address and a handle can lapse. -->
			<p class="mt-3">
				<a class="underline" href={resolve('/(app)/groups/[actor]', { actor: created.groupDid })}
					>Continue to {created.handle}</a
				>
			</p>
		</div>
	{/if}

	<form {...createGroupForm} class="flex flex-col gap-5">
		<div class="flex flex-col gap-1.5">
			<Label for="group-name">Name</Label>
			<Input id="group-name" name="name" bind:value={name} required maxlength={120} />
		</div>

		<!-- Not a URL field. The site's own links carry the group's DID, so this
		     does not decide an address on atmo.rsvp. It decides the handle the
		     mint registers, which reserves the group's name on the network, once. -->
		<div class="flex flex-col gap-1.5">
			<Label for="group-label">Handle</Label>
			<Input
				id="group-label"
				name="label"
				value={derivedLabel}
				oninput={(e) => {
					labelTouched = true;
					label = e.currentTarget.value;
				}}
				required
				pattern={MINTABLE_LABEL_INPUT_PATTERN}
			/>
			<p class="text-base-500 dark:text-base-400 text-xs">
				The first part of the group’s handle, under this site’s group domain:
				<span class="font-mono">{derivedLabel || 'name'}.{data.handleDomain ?? 'example.com'}</span
				>. Creating the group registers that handle, and it is the address the group is known by
				from then on: pick it as carefully as a username, because it is not changeable here
				afterwards.
			</p>
		</div>

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
				Optional, and editable later. Each line becomes its own record in the group’s about space,
				so a rule keeps one stable address even as the list changes.
			</p>
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="group-visibility">Visibility</Label>
			<select
				id="group-visibility"
				name="visibility"
				bind:value={visibility}
				class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
			>
				<option value="public">public — listed and browsable</option>
				<option value="private">private — members only</option>
			</select>
		</div>

		<!-- No space URI field: creating a group also creates its `about` and
		     `members` spaces on the group's own PDS account. The URIs appear on
		     the group page. -->

		<!-- A disabled checkbox is never submitted, and an absent checkbox parses as
		     "off", so the fixed-on case sends its value through a hidden input. -->
		{#if visibility === 'private'}
			<input type="hidden" name="requireApproval" value="on" />
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" checked disabled class="size-4" />
				Require approval to join
			</label>
			<p class="text-base-500 dark:text-base-400 -mt-3 text-xs">
				A private group is invite-only, so approval is always on.
			</p>
		{:else}
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" name="requireApproval" checked class="size-4" />
				Require approval to join
			</label>
		{/if}

		{#if createError}
			<p class="text-sm text-red-600 dark:text-red-400">{createError}</p>
		{/if}

		<div>
			<Button type="submit">Create group</Button>
		</div>
	</form>
</div>

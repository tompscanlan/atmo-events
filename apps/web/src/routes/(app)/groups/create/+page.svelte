<script lang="ts">
	import { Button, Input, Label } from '@foxui/core';

	import { resolve } from '$app/paths';
	import { MINTABLE_LABEL_INPUT_PATTERN, labelFromGroupName } from '$lib/groups/handle-label';
	import { groupFormError, resetOnSuccess } from '$lib/groups/form-result';
	import { GROUP_PASSWORD_MIN_LENGTH } from '$lib/groups/form-fields';
	import { createGroupForm } from '$lib/groups/group.remote';

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
	// The recovery key comes back once, in the form result: on success, and on a
	// failure after the mint, which registered the address anyway. It is read from
	// the result and never fetched again. No route can show it again.
	let registered = $derived.by(() => {
		const result = createGroupForm.result;
		if (!result) return undefined;
		if (result.ok) return result;
		return 'registered' in result ? result.registered : undefined;
	});
	let created = $derived(createGroupForm.result?.ok ? registered : undefined);
</script>

<svelte:head><title>New group - atmo.rsvp</title></svelte:head>

<div class="mx-auto max-w-2xl px-6 py-8 sm:py-12">
	<h1 class="mb-2 text-3xl font-bold">New group</h1>
	<p class="text-base-500 dark:text-base-400 mb-4 text-sm">
		A group is an account on the network. Creating one registers a new identity. Its address becomes
		its handle, so the name has to be free.
	</p>
	<!-- Says who holds what, since the creator holds all of it: the login, the
	     recovery key, and the say over what this site may do as the group. -->
	<p class="text-base-500 dark:text-base-400 mb-8 text-sm">
		<strong>You hold the group's account.</strong> Its login is the email and password you choose
		below, and this site keeps neither. Once the group exists, you link its account: you sign in as
		the group and approve this site to post as it, and you can revoke that at the group's PDS. You
		also get its <strong>recovery key</strong>, with which you can move the group to a host of your
		own later, and nobody, including us, can stop you.
	</p>

	{#if !data.creationConfigured}
		<div
			class="ring-base-200 dark:ring-base-800 text-base-600 dark:text-base-300 mb-8 rounded-2xl p-4 text-sm ring-1"
		>
			<p class="font-semibold">Group creation is not configured on this deployment.</p>
			<p class="mt-1">
				An administrator needs to set <code class="font-mono">GROUP_PDS_SERVICE</code>,
				<code class="font-mono">GROUP_HANDLE_DOMAIN</code>,
				<code class="font-mono">GROUP_PDS_INVITE_CODE</code> and
				<code class="font-mono">OAUTH_PUBLIC_URL</code>, and bind the
				<code class="font-mono">OAUTH_SESSIONS</code> store, first.
			</p>
		</div>
	{/if}

	<!-- Shown once. We never store the private key and cannot show it again. It
	     lets the owner move the group off this PDS without our help, because it
	     is the first PLC rotation key on the account. -->
	{#if registered}
		<div class="mb-8 rounded-2xl p-4 text-sm ring-1 ring-amber-500/40">
			<p class="font-semibold">Save your group's recovery key now.</p>
			{#if !created}
				<p class="mt-1">
					The group was not fully set up (the reason is under the form), but its address was
					registered with this recovery key.
				</p>
			{/if}
			<p class="mt-1">
				This is the only time it is shown. It is not stored anywhere on this service. Keep it
				somewhere safe. With it you can move
				<strong>{registered.handle}</strong> to another host, and without it you cannot.
			</p>
			<!-- The key is for moving the group, not for running it. If the page
			     only said what it unlocks, people could take it for the group's
			     password. -->
			<p class="mt-1">
				It is <em>not</em> the group's password: it will not sign you in, and it is not needed to post,
				edit or invite. Lose it and the group keeps working. You lose only the ability to take it elsewhere
				without us.
			</p>
			<textarea
				readonly
				rows="2"
				class="rounded-ui bg-base-100 dark:bg-base-900 mt-3 w-full border-0 px-3 py-1.5 font-mono text-xs"
				value={registered.recoveryKey}
			></textarea>
		</div>
	{/if}

	<!-- The next step, after the key: this site cannot write as the group until
	     it is linked. A plain post, since the answer is a redirect to the group's
	     PDS. Leaving this page loses the key, so the copy says save it first. -->
	{#if created}
		<form
			method="POST"
			action="/oauth/group-link"
			class="ring-base-200 dark:ring-base-800 mb-8 rounded-2xl p-4 text-sm ring-1"
		>
			<input type="hidden" name="groupDid" value={created.groupDid} />
			<p class="font-semibold">Next: link the group's account.</p>
			<p class="mt-1">
				This site cannot post as <strong>{created.handle}</strong> until you do. At the group's PDS, sign
				in as the group with the email and password you just chose, not as yourself, and approve this
				site. Save the recovery key above first: this page cannot show it again.
			</p>
			<div class="mt-3"><Button type="submit">Link the group's account</Button></div>
			<!-- The link text is the handle, which the owner just chose and will
			     recognize. The href carries the DID, because that is the group's
			     permanent address and a handle can lapse. -->
			<p class="mt-3">
				<a class="underline" href={resolve('/(app)/groups/[actor]', { actor: created.groupDid })}
					>Or continue to {created.handle}</a
				> and link it from there.
			</p>
		</form>
	{/if}

	<!-- Once the group exists, the form has nothing left to do, and leaving it
	     under the recovery key reads as an invitation to submit again. A
	     deployment that cannot create one gets no form, only the notice above. -->
	{#if data.creationConfigured && !created}
		<form {...resetOnSuccess(createGroupForm)} class="flex flex-col gap-5">
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
					<span class="font-mono"
						>{derivedLabel || 'name'}.{data.handleDomain ?? 'example.com'}</span
					>. Creating the group registers that handle, and it is the address the group is known by
					from then on: pick it as carefully as a username, because it is not changeable here
					afterwards.
				</p>
			</div>

			<!-- The group account's login. The creator holds it, so reset mail for the
			     group goes to them, and this site keeps neither field. -->
			<div class="flex flex-col gap-1.5">
				<Label for="group-email">Group account email</Label>
				<Input
					id="group-email"
					name="email"
					type="email"
					autocomplete="email"
					required
					maxlength={254}
				/>
				<p class="text-base-500 dark:text-base-400 text-xs">
					Password reset mail for the group comes here. Each account on the group's PDS needs its
					own address, so if yours already has one there, add a tag:
					<span class="font-mono">you+{derivedLabel || 'mygroup'}@example.com</span>.
				</p>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="group-password">Group account password</Label>
				<!-- Underscored so a failed submit never sends it back to the page. -->
				<Input
					id="group-password"
					name="_password"
					type="password"
					autocomplete="new-password"
					required
					minlength={GROUP_PASSWORD_MIN_LENGTH}
					maxlength={256}
				/>
				<p class="text-base-500 dark:text-base-400 text-xs">
					At least {GROUP_PASSWORD_MIN_LENGTH} characters. You sign in as the group with it to link the
					group to this site. This site does not keep it, so keep it in your password manager.
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
					<option value="public">public: listed and browsable</option>
					<option value="private">private: members only</option>
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
	{/if}
</div>

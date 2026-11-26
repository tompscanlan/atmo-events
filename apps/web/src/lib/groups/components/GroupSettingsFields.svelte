<script lang="ts">
	import { Checkbox, Input, Label, Select, Textarea } from '@atmo-dev/kit';
	import { untrack } from 'svelte';
	import { GROUP_ADDRESS_MAX } from '../fields';

	// Native names, so a plain form post and a script read the same fields.
	let {
		name,
		description,
		joinPolicy,
		isPublic,
		listed,
		website = null,
		address = null
	}: {
		name: string;
		description: string;
		joinPolicy: string;
		isPublic: boolean;
		listed: boolean;
		/** The about record's website; null leaves the field out, as making a group does. */
		website?: string | null;
		/** Making a group: its address, and the host's domain it ends in. */
		address?: { label: string; domain: string } | null;
	} = $props();

	// The form's starting value; the person's choice takes over from there.
	let visibility = $state(untrack(() => (isPublic ? 'public' : 'private')));
</script>

<div>
	<Label for="group-name">Name</Label>
	<Input id="group-name" name="name" value={name} required maxlength={640} />
</div>

{#if address}
	<div>
		<Label for="group-address">Address</Label>
		<div class="flex items-center gap-2">
			<Input
				id="group-address"
				name="address"
				value={address.label}
				required
				maxlength={GROUP_ADDRESS_MAX}
				pattern="[A-Za-z0-9]([A-Za-z0-9\-]*[A-Za-z0-9])?"
				autocapitalize="none"
				spellcheck={false}
				aria-describedby="group-address-help"
			/>
			<span class="text-base-600 dark:text-base-400 shrink-0 text-sm">{address.domain}</span>
		</div>
		<p id="group-address-help" class="text-base-600 dark:text-base-400 mt-1 text-sm">
			Letters, digits and hyphens. It is the group's handle, and can't be changed here later.
		</p>
	</div>
{/if}

<div>
	<Label for="group-description">About the group</Label>
	<Textarea id="group-description" name="description" value={description} rows={4} />
</div>

{#if website !== null}
	<div>
		<Label for="group-website">Website</Label>
		<Input
			id="group-website"
			name="website"
			type="url"
			value={website}
			placeholder="https://example.com"
		/>
	</div>
{/if}

<fieldset class="space-y-2">
	<legend class="text-sm font-medium">Who can see its name and description</legend>
	<label class="flex items-center gap-2 text-sm">
		<input type="radio" name="visibility" value="public" bind:group={visibility} />
		Anyone
	</label>
	<label class="flex items-center gap-2 text-sm">
		<input type="radio" name="visibility" value="private" bind:group={visibility} />
		Only its members
	</label>
	<p class="text-base-600 dark:text-base-400 text-sm">
		Events posted as the group are public either way.
	</p>
</fieldset>

<label class="flex items-center gap-2 text-sm">
	<Checkbox name="listed" checked={listed} disabled={visibility !== 'public'} />
	List it on the groups page, where others can find it
</label>

<div>
	<Label for="group-join">How people join</Label>
	<Select id="group-join" name="joinPolicy" value={joinPolicy}>
		<option value="open">Anyone can join</option>
		<option value="approval">People ask, and an admin decides</option>
		<option value="invite">Only people an admin invites</option>
	</Select>
</div>

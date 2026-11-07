<script lang="ts">
	import { Checkbox, Input, Label, Select, Textarea } from '@atmo-dev/kit';
	import { untrack } from 'svelte';

	// Native names, so a plain form post and a script read the same fields.
	let {
		name,
		description,
		joinPolicy,
		isPublic,
		listed
	}: {
		name: string;
		description: string;
		joinPolicy: string;
		isPublic: boolean;
		listed: boolean;
	} = $props();

	// The form's starting value; the person's choice takes over from there.
	let visibility = $state(untrack(() => (isPublic ? 'public' : 'private')));
</script>

<div>
	<Label for="group-name">Name</Label>
	<Input id="group-name" name="name" value={name} required maxlength={640} />
</div>

<div>
	<Label for="group-description">About the group</Label>
	<Textarea id="group-description" name="description" value={description} rows={4} />
</div>

<fieldset class="space-y-2">
	<legend class="text-sm font-medium">Who can see it</legend>
	<label class="flex items-center gap-2 text-sm">
		<input type="radio" name="visibility" value="public" bind:group={visibility} />
		Anyone: its name, events and members page are public
	</label>
	<label class="flex items-center gap-2 text-sm">
		<input type="radio" name="visibility" value="private" bind:group={visibility} />
		Only its members
	</label>
</fieldset>

<label class="flex items-center gap-2 text-sm">
	<Checkbox name="listed" checked={listed} disabled={visibility !== 'public'} />
	List it on the groups page
</label>

<div>
	<Label for="group-join">How people join</Label>
	<Select id="group-join" name="joinPolicy" value={joinPolicy}>
		<option value="open">Anyone can join</option>
		<option value="approval">People ask, and an admin decides</option>
		<option value="invite">Only people an admin adds</option>
	</Select>
</div>

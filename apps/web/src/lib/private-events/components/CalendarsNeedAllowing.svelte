<script lang="ts">
	import { resolve } from '$app/paths';

	// For a host who can host events but hasn't allowed shared calendars, which a sign-in from before
	// calendars came lacks: where naming a list of people would be offered, the way to allow it, on
	// Calendars, where the permission is asked for.
</script>

<p class="text-base-600 dark:text-base-400 mt-2 text-sm" data-testid="calendars-need-allowing">
	To reuse these people for later events, allow shared calendars first, under
	<a href={resolve('/(app)/private')} class="text-accent-600 dark:text-accent-400 hover:underline"
		>Calendars</a
	>.
</p>

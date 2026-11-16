import { invalidateAll } from '$app/navigation';
import { page } from '$app/state';

/** What a refused command says, in the words the server gave it; anything else in plain words. */
export function refusalWords(e: unknown): string {
	const message = (e as { body?: { message?: unknown } } | null)?.body?.message;
	return typeof message === 'string' ? message : 'That did not work. Try again.';
}

/** One change at a time: `busy` while it runs, and a refusal, in words, in `failure`. */
export class Changes {
	busy = $state(false);
	failure: string | null = $state(null);

	async run(change: () => Promise<unknown>): Promise<void> {
		this.busy = true;
		this.failure = null;
		try {
			await change();
		} catch (e) {
			this.failure = refusalWords(e);
		} finally {
			this.busy = false;
		}
	}
}

/** A list of people its owner adds to by handle and removes from. The page's data is read again
 *  after each change. */
export class PeopleEditor extends Changes {
	handle = $state('');
	copied = $state(false);

	constructor(
		private readonly put: (handleOrDid: string) => Promise<unknown>,
		private readonly take: (did: string) => Promise<unknown>
	) {
		super();
	}

	add = (event: SubmitEvent) => {
		event.preventDefault();
		return this.run(async () => {
			await this.put(this.handle);
			this.handle = '';
			await invalidateAll();
		});
	};

	remove = (did: string) =>
		this.run(async () => {
			await this.take(did);
			await invalidateAll();
		});

	copyLink = async () => {
		await navigator.clipboard.writeText(page.url.origin + page.url.pathname);
		this.copied = true;
	};
}

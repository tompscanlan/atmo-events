// GROUP_HOST_URL as groups read it, in the Worker and in contrail's CLI alike: an http(s) URL turns
// groups on; blank, or anything that is not one, leaves them off. A pure check, so the CLI, which
// runs outside the Worker, can import it.

export function parseGroupHostUrl(value: string | undefined): URL | null {
	const raw = value?.trim();
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return /^https?:$/.test(url.protocol) ? url : null;
	} catch {
		return null;
	}
}

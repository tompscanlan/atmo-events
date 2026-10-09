// Links into pds.ls, a public repo browser, so anyone can read the record a group
// page describes straight from the PDS that holds it. pds.ls takes the at:// URI as
// its path, for an account, a record, a space or a record in a space
// (`spaceRecordUri`) alike. A space's contents open only for a viewer signed in to
// pds.ls with an account the space admits.
const PDSLS = 'https://pds.ls';

/** The pds.ls page for an at:// URI, or for a bare DID's repo. */
export function pdslsUrl(target: string): string {
	return `${PDSLS}/${target.startsWith('at://') ? target : `at://${target}`}`;
}

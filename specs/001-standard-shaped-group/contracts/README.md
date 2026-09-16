# Contracts — fidelity ledger

**Source**: `opensocial.community proposal`, dholms, 2026-08-18 (Google Doc), read in full
2026-09-15. Cross-checked against `atproto-permissioned-data` @ `f4a1f5f8c` (the simplespace alpha)
and the 2026-09-13 live probe of `pds.opnmt.net`.

**What the source publishes**: space types, record types (with space / author / key / purpose),
a 12-item action vocabulary, and a 25-method host surface. Plus the design posture: flat RBAC,
union composition, no deny rules, no precedence.

**What the source does NOT publish**: field-level lexicon JSON. There is no `defs.json` for
`community.opensocial.*` anywhere public. Therefore:

> Every field list in `records.md` is **provisional** — derived from the proposal's prose, not
> transcribed from a schema. Field names MUST live behind a builder per record class so a published
> lexicon can replace them in one place. Do not let a provisional field name leak into a route, a
> D1 column, or a test assertion.

Writing more field detail into `spec.md` would be invention, not specification. That is the ceiling
the source sets, and it is why iteration 1 is scoped to *placement* rather than to schema fidelity.

## One structural fact that changes how we read the standard

> *"opensocial.community is a peer to the simplespace implementation that is required for PDSes to
> implement. It is not expected to operate on most PDSes and does not layer on top of simplespaces."*

The standard assumes a **community-aware space host**, not a stock PDS running simplespace. We are
building on simplespace. So iteration 1 is a *managing app emulating a host*, and that is a
deliberate interim (see `spaces-and-policy.md` § Emulation boundary). It is also the honest framing
for the `flo-bit/atmo-events#78` design comment: we are not running the standard, we are proving its
record placement on the alpha.

## Iteration-1 coverage

| Standard surface | Iteration 1 | Where |
|---|---|---|
| `declaration` in public repo | **yes** | FR-003 / `om-fkpvi` |
| `about` space + `profile` + `rule` | **yes** (authority-authored) | FR-002, FR-004 / `om-kp7ss.2`, `.3` |
| `members` space + `role` + `permissions` | **yes** | FR-005 / `om-i92w3` |
| `membership` (authority) + `access` | **yes** | FR-006 / `om-ypwkc` |
| `acceptance` (member-authored) | no — iteration 2 | `om-kp7ss.5` |
| `space` (the space index record) | no — deferred by decomposition §1 G0 | relates to `om-pfodd` |
| `label`, `invite` | no | moderation / invites tracks |
| The 25 host methods | **none served** | no group host exists (`om-gs9ja`, OQ-D) |
| Community-as-moderation-service | no | not in any iteration yet |
| OAuth AS for the community DID | no — password session interim | `om-jc4lh`, OQ-C |

Nothing in the "no" rows is a disagreement with the standard. Each is either an undecided question
or a dependency that does not exist yet.

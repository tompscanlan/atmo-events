import { defineLexiconConfig } from "@atcute/lex-cli";

// `pnpm generate` rewrites this file and adds group.opensocial.declaration to the
// pull list. That NSID does not resolve, so take it out again. The declaration's
// lexicon is in lexicons/custom (see src/lib/groups/README.md).
export default defineLexiconConfig({
  files: ["lexicons/custom/**/*.json", "lexicons/pulled/**/*.json", "lexicons/generated/**/*.json"],
  outdir: "src/lexicon-types/",
  imports: ["@atcute/atproto"],
  pull: {
    outdir: "lexicons/pulled/",
    sources: [
      {
        type: "atproto",
        mode: "nsids",
        nsids: [
                  "app.bsky.actor.profile",
                  "community.lexicon.calendar.event",
                  "community.lexicon.calendar.rsvp",
                  "community.lexicon.location.address",
                  "community.lexicon.location.fsq",
                  "community.lexicon.location.geo",
                  "community.lexicon.location.hthree"
        ],
      },
    ],
  },
});

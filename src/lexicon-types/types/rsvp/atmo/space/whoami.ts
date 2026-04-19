import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.query("rsvp.atmo.space.whoami", {
  params: /*#__PURE__*/ v.object({
    spaceUri: /*#__PURE__*/ v.resourceUriString(),
  }),
  output: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      isMember: /*#__PURE__*/ v.boolean(),
      isOwner: /*#__PURE__*/ v.boolean(),
      /**
       * Present only when the caller is a member or the owner.
       */
      perms: /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.string<"read" | "write" | (string & {})>(),
      ),
    }),
  },
});

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface $params extends v.InferInput<mainSchema["params"]> {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
  interface XRPCQueries {
    "rsvp.atmo.space.whoami": mainSchema;
  }
}

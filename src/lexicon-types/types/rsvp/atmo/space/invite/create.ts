import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";
import * as RsvpAtmoSpaceDefs from "../defs.js";

const _mainSchema = /*#__PURE__*/ v.procedure("rsvp.atmo.space.invite.create", {
  params: null,
  input: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      /**
       * Unix ms timestamp. Omit for no expiry.
       */
      expiresAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.integer()),
      /**
       * join: redeem to become a member. read: bearer-only read access, no membership. read-join: anonymous read + signed-in redeem to join.
       * @default "join"
       */
      kind: /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.string<"join" | "read" | "read-join" | (string & {})>(),
        "join",
      ),
      /**
       * Caps join redemptions only — read-token reads are unlimited. Omit for unlimited joins.
       * @minimum 1
       */
      maxUses: /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.integer(), [
          /*#__PURE__*/ v.integerRange(1),
        ]),
      ),
      /**
       * @maxLength 500
       */
      note: /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
          /*#__PURE__*/ v.stringLength(0, 500),
        ]),
      ),
      /**
       * @default "write"
       */
      perms: /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.string<"read" | "write" | (string & {})>(),
        "write",
      ),
      spaceUri: /*#__PURE__*/ v.resourceUriString(),
    }),
  },
  output: {
    type: "lex",
    schema: /*#__PURE__*/ v.object({
      get invite() {
        return RsvpAtmoSpaceDefs.inviteViewSchema;
      },
      /**
       * Raw token. Shown once — cannot be retrieved later.
       */
      token: /*#__PURE__*/ v.string(),
    }),
  },
});

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface $params {}
export interface $input extends v.InferXRPCBodyInput<mainSchema["input"]> {}
export interface $output extends v.InferXRPCBodyInput<mainSchema["output"]> {}

declare module "@atcute/lexicons/ambient" {
  interface XRPCProcedures {
    "rsvp.atmo.space.invite.create": mainSchema;
  }
}

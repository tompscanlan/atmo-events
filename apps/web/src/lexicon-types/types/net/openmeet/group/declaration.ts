import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.record(
  /*#__PURE__*/ v.literal("self"),
  /*#__PURE__*/ v.object({
    $type: /*#__PURE__*/ v.literal("net.openmeet.group.declaration"),
    /**
     * The group's about space, which holds its profile and rules: at://<group DID>/space/<space type>/<space key>. Reading it needs a credential.
     * @maxLength 8192
     */
    aboutSpace: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
      /*#__PURE__*/ v.stringLength(0, 8192),
    ]),
    /**
     * When the group was created. Rewriting the declaration keeps this date.
     */
    createdAt: /*#__PURE__*/ v.datetimeString(),
  }),
);

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface Main extends v.InferInput<typeof mainSchema> {}

declare module "@atcute/lexicons/ambient" {
  interface Records {
    "net.openmeet.group.declaration": mainSchema;
  }
}

import type { Context } from "@bb-kit/core/plugin";
import { defineMutation } from "@bb-kit/core/rpc";
import { configurationSchema, configurationViewSchema } from "../../shared/configuration.ts";
import type { Limiter } from "../lib/limiter.ts";

/** Replaces the overall limit and the host overrides, and returns the new view. */
export const setConfiguration = defineMutation({
  input: configurationSchema,
  output: configurationViewSchema,
  async execute(ctx: Context<{ limiter: Limiter }>, next) {
    await ctx.limiter.save(next);
    return ctx.limiter.view();
  },
});

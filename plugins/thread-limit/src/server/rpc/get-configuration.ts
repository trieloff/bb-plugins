import type { Context } from "@bb-kit/core/plugin";
import { defineQuery } from "@bb-kit/core/rpc";
import { configurationViewSchema } from "../../shared/configuration.ts";
import type { Limiter } from "../lib/limiter.ts";

/** Every host with its processors and limits, for the settings page. */
export const getConfiguration = defineQuery({
  output: configurationViewSchema,
  async execute(ctx: Context<{ limiter: Limiter }>) {
    return ctx.limiter.view();
  },
});

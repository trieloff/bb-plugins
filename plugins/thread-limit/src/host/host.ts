import { availableParallelism } from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { threadLimitHostContract } from "../shared/host-contract.ts";
import { createLoadReader } from "./load.ts";

const readLoad = createLoadReader();

export default experimental_defineHostEntry({
  contract: threadLimitHostContract,
  handlers: {
    getCapacity() {
      return { availableParallelism: availableParallelism() };
    },
    getLoad() {
      return readLoad();
    },
  },
});

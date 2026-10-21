// Ported from bb's concurrency-limit plugin (app.test.tsx at
// desktop-v0.46.1), on bun:test with bb-kit's DOM.
import { afterEach, describe, expect, it } from "bun:test";
import { installDom } from "@bb-kit/core/testing";

// The DOM must exist before the SDK's render harness is evaluated.
installDom();
const { cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

const app = await loadPluginApp(() => import("./app.tsx"));

afterEach(cleanup);

const hosts = [
  {
    id: "host-a",
    name: "Laptop",
    status: "connected" as const,
    availableParallelism: 8,
    automaticLimit: 8,
    effectiveLimit: 8,
    override: null,
  },
  {
    id: "host-b",
    name: "Studio",
    status: "disconnected" as const,
    availableParallelism: null,
    automaticLimit: 1,
    effectiveLimit: 1,
    override: null,
  },
];

interface ConfigurationInput {
  globalLimit: number | null;
  hostOverrides: Array<{ hostId: string; limit: number }>;
}

function configurationInput(input: unknown): ConfigurationInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("Expected configuration input");
  }
  const globalLimit = Reflect.get(input, "globalLimit");
  const rawOverrides = Reflect.get(input, "hostOverrides");
  if ((globalLimit !== null && typeof globalLimit !== "number") || !Array.isArray(rawOverrides)) {
    throw new Error("Expected configuration input");
  }
  const hostOverrides = rawOverrides.map((rawOverride) => {
    if (typeof rawOverride !== "object" || rawOverride === null) {
      throw new Error("Expected host override");
    }
    const hostId = Reflect.get(rawOverride, "hostId");
    const limit = Reflect.get(rawOverride, "limit");
    if (typeof hostId !== "string" || typeof limit !== "number") {
      throw new Error("Expected host override");
    }
    return { hostId, limit };
  });
  return { globalLimit, hostOverrides };
}

describe("Concurrency limit settings", () => {
  it("shows compact automatic per-host defaults", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getConfiguration: () => ({
            globalLimit: null,
            hostOverrides: [],
            hosts,
          }),
          setConfiguration: (input) => ({
            ...configurationInput(input),
            hosts,
          }),
        },
      },
    );

    expect(await slot.findByText("Host limits")).toBeTruthy();
    expect(slot.getByText("Auto allows one thread per available processor.")).toBeTruthy();
    expect(slot.getByText("8 processors")).toBeTruthy();
    expect(slot.getByText("Offline")).toBeTruthy();
    expect(
      slot.getByRole("spinbutton", { name: "Laptop thread limit" }).getAttribute("placeholder"),
    ).toBe("Auto (8)");
  });

  it("saves overall and per-host limits without accepting invalid numbers", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getConfiguration: () => ({
            globalLimit: null,
            hostOverrides: [],
            hosts,
          }),
          setConfiguration: (input) => {
            const configuration = configurationInput(input);
            return {
              ...configuration,
              hosts: hosts.map((host) => {
                const override = configuration.hostOverrides.find(
                  (candidate) => candidate.hostId === host.id,
                );
                return override === undefined
                  ? host
                  : Object.assign({}, host, {
                      effectiveLimit: override.limit,
                      override: override.limit,
                    });
              }),
            };
          },
        },
      },
    );

    const overall = await slot.findByRole("spinbutton", {
      name: "Overall thread limit",
    });
    fireEvent.change(overall, { target: { value: "1.5" } });
    fireEvent.blur(overall);
    expect((await slot.findByRole("alert")).textContent).toBe(
      "Use a whole number from 0 to 10000, or leave blank.",
    );
    expect(slot.rpcCalls.filter((call) => call.method === "setConfiguration")).toHaveLength(0);

    fireEvent.change(overall, { target: { value: "3" } });
    fireEvent.blur(overall);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setConfiguration",
        input: { globalLimit: 3, hostOverrides: [] },
      }),
    );

    const laptop = slot.getByRole("spinbutton", {
      name: "Laptop thread limit",
    });
    fireEvent.change(laptop, { target: { value: "2" } });
    fireEvent.blur(laptop);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setConfiguration",
        input: {
          globalLimit: 3,
          hostOverrides: [{ hostId: "host-a", limit: 2 }],
        },
      }),
    );
  });
});

// Added for the copy: load limits and each host's live load.
describe("Thread limit load settings", () => {
  const loadLimits = { cpuBusyPercent: 85, memoryFreePercent: 10 };
  const busyHosts = [
    Object.assign({}, hosts[0], {
      load: { cpuBusyPercent: 92.4, memoryFreePercent: 61, loadAverage: 30, sampledAt: 1 },
      overloadedBy: "CPU 92% busy",
    }),
    Object.assign({}, hosts[1], { load: null, overloadedBy: null }),
  ];

  it("shows each host's load and saves load limits, refusing a bad percent", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getConfiguration: () => ({
            globalLimit: 2,
            hostOverrides: [],
            loadLimits,
            hosts: busyHosts,
          }),
          setConfiguration: (input) => Object.assign({}, input as object, { hosts: busyHosts }),
        },
      },
    );

    expect(await slot.findByText("Load limits")).toBeTruthy();
    expect(slot.getByText(/CPU 92%/u).textContent).toContain("61% memory free");
    expect(slot.getByText(/Holding new turns/u)).toBeTruthy();

    const cpu = slot.getByRole("spinbutton", { name: "Hold new turns while CPU is this busy" });
    expect((cpu as HTMLInputElement).value).toBe("85");
    fireEvent.change(cpu, { target: { value: "150" } });
    fireEvent.blur(cpu);
    expect((await slot.findByRole("alert")).textContent).toBe(
      "Use a whole percent from 1 to 100, or leave blank to turn it off.",
    );
    expect(slot.rpcCalls.filter((call) => call.method === "setConfiguration")).toHaveLength(0);

    fireEvent.change(cpu, { target: { value: "70" } });
    fireEvent.blur(cpu);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setConfiguration",
        input: {
          globalLimit: 2,
          hostOverrides: [],
          loadLimits: { cpuBusyPercent: 70, memoryFreePercent: 10 },
        },
      }),
    );

    const memory = slot.getByRole("spinbutton", {
      name: "Hold new turns while this little memory is free",
    });
    fireEvent.change(memory, { target: { value: "" } });
    fireEvent.blur(memory);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setConfiguration",
        input: {
          globalLimit: 2,
          hostOverrides: [],
          loadLimits: { cpuBusyPercent: 70, memoryFreePercent: null },
        },
      }),
    );
  });
});

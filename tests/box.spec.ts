import { BoxError, type Box } from "@upstash/box";
import { describe, expect, it } from "vitest";
import {
  boxApiKey,
  boxNameFor,
  credentialConfigFor,
  deleteBoxForMapping,
  ensureRunning,
  findBoxForMapping,
  labelsFor,
  mappingLabel,
  openBox,
  providerApiKey,
  requireProviderApiKey,
} from "../src/box.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { fakeBox, fakeClient, listing, MAPPING_ID, sampleMapping } from "./helpers.js";

describe("keys", () => {
  it("requires the Box key from the environment or secrets", () => {
    expect(() => boxApiKey({ env: {}, secrets: {} })).toThrow(/UPSTASH_BOX_API_KEY/);
    expect(boxApiKey({ env: {}, secrets: { UPSTASH_BOX_API_KEY: "k" } })).toBe("k");
  });

  it("derives the provider variable from the model prefix", () => {
    const env = { OPENROUTER_API_KEY: "or", ANTHROPIC_API_KEY: "an" };
    expect(providerApiKey(DEFAULT_CONFIG, { env, secrets: {} })).toEqual({
      name: "ANTHROPIC_API_KEY",
      value: "an",
    });
    expect(
      providerApiKey(
        { ...DEFAULT_CONFIG, model: "openrouter/anthropic/claude-sonnet-5" },
        { env, secrets: {} },
      ),
    ).toEqual({ name: "OPENROUTER_API_KEY", value: "or" });
  });

  it("prefers a Claude subscription token over an Anthropic key, for Claude Code only", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "an" };
    expect(providerApiKey(DEFAULT_CONFIG, { env, secrets: {} })).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "t",
    });
    expect(
      providerApiKey({ ...DEFAULT_CONFIG, harness: "opencode" }, { env, secrets: {} }),
    ).toEqual({
      name: "ANTHROPIC_API_KEY",
      value: "an",
    });
  });

  it("never substitutes another variable for an explicit providerApiKeyEnv", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "an" };
    const config = { ...DEFAULT_CONFIG, providerApiKeyEnv: "MY_KEY" };
    expect(providerApiKey(config, { env, secrets: {} })).toBeNull();
    expect(() => requireProviderApiKey(config, { env, secrets: {} })).toThrow(/MY_KEY is needed/);
  });

  it("ignores a providerApiKeyEnv written for another harness on reconnect", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "t", OPENAI_API_KEY: "o" };
    const setupShaped = { ...DEFAULT_CONFIG, providerApiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN" };
    const codexMapping = { harness: "codex" as const, model: "openai/gpt-5.6" };
    expect(credentialConfigFor(setupShaped, codexMapping)).toEqual({
      providerApiKeyEnv: null,
      harness: "codex",
      model: "openai/gpt-5.6",
    });
    expect(
      providerApiKey(credentialConfigFor(setupShaped, codexMapping), { env, secrets: {} }),
    ).toEqual({ name: "OPENAI_API_KEY", value: "o" });
    const claudeMapping = { harness: "claude-code" as const, model: "anthropic/claude-sonnet-5" };
    expect(credentialConfigFor(setupShaped, claudeMapping).providerApiKeyEnv).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN",
    );
  });

  it("ignores a subscription-token name for a mapping on an openrouter/ model", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "t", OPENROUTER_API_KEY: "or" };
    const setupShaped = { ...DEFAULT_CONFIG, providerApiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN" };
    const openrouterBox = {
      harness: "claude-code" as const,
      model: "openrouter/anthropic/claude-sonnet-5",
    };
    expect(credentialConfigFor(setupShaped, openrouterBox).providerApiKeyEnv).toBeNull();
    expect(
      providerApiKey(credentialConfigFor(setupShaped, openrouterBox), { env, secrets: {} }),
    ).toEqual({ name: "OPENROUTER_API_KEY", value: "or" });
    // A custom name is the user's own override and survives as long as the harness matches.
    const custom = { ...DEFAULT_CONFIG, providerApiKeyEnv: "MY_KEY" };
    expect(credentialConfigFor(custom, openrouterBox).providerApiKeyEnv).toBe("MY_KEY");
  });

  it("lets config name the variable and says which one is missing", () => {
    const config = { ...DEFAULT_CONFIG, providerApiKeyEnv: "MY_KEY" };
    expect(providerApiKey(config, { env: { MY_KEY: "v" }, secrets: {} })?.value).toBe("v");
    expect(() => requireProviderApiKey(config, { env: {}, secrets: {} })).toThrow(
      /MY_KEY is needed for model/,
    );
  });
});

describe("naming", () => {
  it("builds a stable, bounded, slug-safe box name", () => {
    const input = {
      prefix: "herdr",
      harness: "claude-code",
      localRoot: "/Users/me/Very Long Repository Name With Spaces And More Words Than Fit",
      mappingId: MAPPING_ID,
    };
    const name = boxNameFor(input);
    expect(name).toMatch(/^herdr-claude-code-[a-z0-9-]+-[0-9a-f]{8}$/);
    expect(name.length).toBeLessThanOrEqual(60);
    expect(boxNameFor(input)).toBe(name);
    const other = boxNameFor({
      ...input,
      localRoot: "/Users/me/repo",
      mappingId: "22222222-2222-4222-8222-222222222222",
    });
    expect(other).toBe(`herdr-claude-code-repo-${other.slice(-8)}`);
    expect(other.slice(-8)).not.toBe(name.slice(-8));
  });

  it("labels carry 64 bits of the mapping id and fit the Box label rules", () => {
    expect(mappingLabel(MAPPING_ID)).toBe("hm:1234567812344123");
    for (const label of labelsFor(MAPPING_ID)) {
      expect(label.length).toBeLessThanOrEqual(20);
      expect(label).toMatch(/^[A-Za-z0-9._:-]+$/);
    }
  });
});

describe("box recovery", () => {
  it("uses the recorded box id", async () => {
    const { box } = fakeBox({ id: "box-1" });
    const client = fakeClient({ "box-1": box });
    expect(await openBox(sampleMapping(), { client, apiKey: "k" })).toBe(box);
    expect(client.gets).toEqual(["box-1"]);
  });

  it("recovers through the label only when the name also matches", async () => {
    const mapping = sampleMapping({ boxId: null });
    const { box } = fakeBox({ id: "box-2" });
    const client = fakeClient(
      { "box-2": box },
      listing([
        { id: "old", status: "deleted", name: mapping.boxName },
        { id: "impostor", name: "someone-elses-box" },
        { id: "box-2", name: mapping.boxName },
      ]),
    );
    expect(await findBoxForMapping(mapping, client, "k")).toMatchObject({ id: "box-2" });
    expect(await openBox(mapping, { client, apiKey: "k" })).toBe(box);
  });

  it("refuses to guess between several matching boxes", async () => {
    const mapping = sampleMapping({ boxId: null });
    const client = fakeClient(
      {},
      listing([
        { id: "one", name: mapping.boxName },
        { id: "two", name: mapping.boxName },
      ]),
    );
    await expect(findBoxForMapping(mapping, client, "k")).rejects.toMatchObject({
      code: "ambiguous_box",
    });
  });

  it("names a mapping that has no box at all", async () => {
    await expect(
      openBox(sampleMapping({ boxId: null }), { client: fakeClient({}, []), apiKey: "k" }),
    ).rejects.toThrow(/has no box yet/);
  });
});

describe("ensureRunning", () => {
  const sleep = async () => undefined;

  it("leaves a live box alone", async () => {
    const { box, calls } = fakeBox({ statuses: ["idle"] });
    expect(await ensureRunning(box, { sleep })).toEqual({ status: "idle", resumed: false });
    expect(calls.resumed).toBe(0);
  });

  it("resumes a paused box and waits for it", async () => {
    const { box, calls } = fakeBox({ statuses: ["paused", "creating", "running"] });
    const resumes: string[] = [];
    const result = await ensureRunning(box, { sleep, onResume: () => resumes.push("x") });
    expect(result).toEqual({ status: "running", resumed: true });
    expect(calls.resumed).toBe(1);
    expect(resumes).toHaveLength(1);
  });

  it("refuses a deleted box and times out on one that never returns", async () => {
    const gone = fakeBox({ statuses: ["deleted"] });
    await expect(ensureRunning(gone.box, { sleep })).rejects.toThrow(/has been deleted/);
    let clock = 0;
    const stuck = fakeBox({ statuses: ["paused", "creating"] });
    await expect(
      ensureRunning(stuck.box, { sleep, timeoutMs: 3000, now: () => (clock += 1000) }),
    ).rejects.toThrow(/did not come back/);
  });
});

describe("deleteBoxForMapping", () => {
  it("deletes through the SDK", async () => {
    const { box, calls } = fakeBox();
    const client = fakeClient({ "box-1": box });
    expect(await deleteBoxForMapping(sampleMapping(), { client, apiKey: "k" })).toBe("deleted");
    expect(calls.deleted).toBe(1);
  });

  it("treats a missing box as already gone", async () => {
    expect(
      await deleteBoxForMapping(sampleMapping({ boxId: null }), {
        client: fakeClient({}, []),
        apiKey: "k",
      }),
    ).toBe("already_gone");
    const notFound = {
      ...fakeClient({}),
      async get() {
        throw new BoxError("not found", 404);
      },
    };
    expect(await deleteBoxForMapping(sampleMapping(), { client: notFound, apiKey: "k" })).toBe(
      "already_gone",
    );
    const gone = {
      id: "box-1",
      async delete() {
        throw new BoxError("gone", 404);
      },
    } as unknown as Box;
    expect(
      await deleteBoxForMapping(sampleMapping(), {
        client: fakeClient({ "box-1": gone }),
        apiKey: "k",
      }),
    ).toBe("already_gone");
  });
});

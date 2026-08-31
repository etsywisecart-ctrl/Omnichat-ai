import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_KEY ??= "test-key";

const realFetch = globalThis.fetch;

/** Stub the Gemini endpoint with a scripted sequence of responses. */
function stubGemini(script: unknown[]) {
  const requests: Array<Record<string, unknown>> = [];
  let turn = 0;

  globalThis.fetch = (async (url: unknown, init: { body: string }) => {
    if (String(url).includes("generativelanguage")) {
      requests.push(JSON.parse(init.body));
      const payload = script[Math.min(turn, script.length - 1)];
      turn++;
      return { ok: true, status: 200, json: async () => payload };
    }
    // Supabase: return an empty result set for anything else.
    return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
  }) as unknown as typeof fetch;

  return requests;
}

describe("AI tool loop", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("executes a tool call, feeds the result back, and answers in prose", async () => {
    const requests = stubGemini([
      {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "search_products", args: { query: "mug" } } }],
            },
          },
        ],
      },
      { candidates: [{ content: { parts: [{ text: "We have the Blue Mug at 18.00 USD." }] } }] },
    ]);

    const { generateCustomerReply } = await import("@/lib/ai/gemini");
    const reply = await generateCustomerReply("biz-1", "do you have a mug?", [], {
      channelType: "whatsapp",
      conversationId: "conv-1",
    });

    assert.equal(reply.source, "gemini");
    assert.ok(reply.text.length > 0, "must produce a reply");
    assert.equal(reply.toolsUsed.length, 1, "must run exactly one tool");
    assert.equal(reply.toolsUsed[0].name, "search_products");

    assert.equal(requests.length, 2, "must make two model round-trips");
    assert.ok(Array.isArray(requests[0].tools), "tools must be declared");

    // The second turn must replay the model's call AND carry our response,
    // otherwise the model has no idea what the tool returned.
    const second = JSON.stringify(requests[1].contents);
    assert.match(second, /functionCall/);
    assert.match(second, /functionResponse/);
  });

  test("never throws when every model is unavailable", async () => {
    stubGemini([]);
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "",
    })) as unknown as typeof fetch;

    const { generateCustomerReply } = await import("@/lib/ai/gemini");
    const reply = await generateCustomerReply("biz-1", "hello?", []);

    // A throw here would 500 the webhook, and Meta would retry — sending the
    // customer the same reply twice.
    assert.ok(reply.text.length > 0);
    assert.ok(reply.source === "error" || reply.source === "catalog");
  });

  test("never throws when the API key is missing", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const { generateCustomerReply } = await import("@/lib/ai/gemini");
      const reply = await generateCustomerReply("biz-1", "hello?", []);
      assert.ok(reply.text.length > 0);
    } finally {
      process.env.GEMINI_API_KEY = saved;
    }
  });

  test("never throws on a missing business id", async () => {
    const { generateCustomerReply } = await import("@/lib/ai/gemini");
    const reply = await generateCustomerReply("", "hi", []);
    assert.ok(reply.text.length > 0);
  });
});

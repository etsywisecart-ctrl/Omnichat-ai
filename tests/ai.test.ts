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

describe("failure reasons reach the surface", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Answer the Gemini endpoint with one canned failure; Supabase gets []. */
  function stubGeminiFailure(status: number, payload: unknown) {
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("generativelanguage")) {
        return { ok: status < 400, status, json: async () => payload };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
    }) as unknown as typeof fetch;
  }

  test("carries Google's own message, not just the status code", async () => {
    stubGeminiFailure(404, {
      error: { message: "models/gemini-2.5-flash is not found for API version v1beta" },
    });

    const { generateCustomerReply } = await import("@/lib/ai/gemini");
    const reply = await generateCustomerReply("biz-1", "do you have a mug?", []);

    assert.notEqual(reply.source, "gemini");
    // Without this the operator sees a catalog fallback and no cause at all —
    // the exact failure that cost a day of guessing.
    assert.ok(reply.reason, "a fallback must say why the model didn't answer");
    assert.match(reply.reason!, /404/);
    assert.match(reply.reason!, /is not found for API version/);
  });

  test("names the finishReason when a 200 comes back with no content", async () => {
    stubGeminiFailure(200, { candidates: [{ finishReason: "SAFETY", content: {} }] });

    const { generateCustomerReply } = await import("@/lib/ai/gemini");
    const reply = await generateCustomerReply("biz-1", "hello?", []);

    assert.ok(reply.reason);
    assert.match(reply.reason!, /SAFETY/);
  });

  test("reports every model it tried, not only the last", async () => {
    stubGeminiFailure(429, { error: { message: "Quota exceeded" } });

    const { generateCustomerReply, GEMINI_MODELS } = await import("@/lib/ai/gemini");
    const reply = await generateCustomerReply("biz-1", "hello?", []);

    for (const model of GEMINI_MODELS) {
      assert.ok(reply.reason!.includes(model), `${model} must appear in the reason`);
    }
  });

  test("says the key is missing rather than failing silently", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const { generateCustomerReply } = await import("@/lib/ai/gemini");
      const reply = await generateCustomerReply("biz-1", "hello?", []);
      assert.match(reply.reason ?? "", /GEMINI_API_KEY/);
    } finally {
      process.env.GEMINI_API_KEY = saved;
    }
  });
});

describe("catalog keyword search", () => {
  test("pulls the product words out of a whole sentence", async () => {
    const { searchKeywords } = await import("@/lib/ai/gemini");

    // The bug verbatim: this sentence went to the database as one ILIKE
    // pattern, so it looked for a product literally named that.
    const words = searchKeywords("do you have an espresso cup set?");
    assert.deepEqual(words.sort(), ["cup", "espresso", "set"].sort());
  });

  test("keeps at most five words, longest first", async () => {
    const { searchKeywords } = await import("@/lib/ai/gemini");

    const words = searchKeywords(
      "looking for a large ceramic handmade espresso cup saucer set gift"
    );
    assert.equal(words.length, 5);
    // The specific word is nearly always the long one, and we only get five.
    assert.ok(words.includes("handmade"));
    assert.ok(words.includes("espresso"));
  });

  test("drops duplicates and punctuation", async () => {
    const { searchKeywords } = await import("@/lib/ai/gemini");

    assert.deepEqual(searchKeywords("Mug, mug... MUG!"), ["mug"]);
  });

  test("falls back to the whole phrase when it is all stopwords", async () => {
    const { searchKeywords } = await import("@/lib/ai/gemini");

    // Better to search for something and find nothing than to search for
    // nothing and report an empty catalog.
    assert.deepEqual(searchKeywords("do you have any?"), ["do you have any?"]);
    assert.deepEqual(searchKeywords("   "), []);
  });

  test("keeps non-Latin scripts intact", async () => {
    const { searchKeywords } = await import("@/lib/ai/gemini");

    const words = searchKeywords("هل لديك كوب اسبريسو؟");
    assert.ok(words.length > 0, "an Arabic question must still produce keywords");
    assert.ok(!words.join(" ").includes("؟"));
  });
});

describe("generation config", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("turns thinking off for 2.5 models and leaves it off the wire for older ones", async () => {
    const seen: Array<{ model: string; body: Record<string, any> }> = [];

    globalThis.fetch = (async (url: unknown, init: { body: string }) => {
      const href = String(url);
      if (href.includes("generativelanguage")) {
        const model = href.split("/models/")[1].split(":")[0];
        seen.push({ model, body: JSON.parse(init.body) });
        // Fail every model so the loop walks the whole list.
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
    }) as unknown as typeof fetch;

    const { generateCustomerReply } = await import("@/lib/ai/gemini");
    await generateCustomerReply("biz-1", "do you have a mug?", []);

    assert.ok(seen.length > 0, "at least one model must be attempted");

    for (const { model, body } of seen) {
      const config = body.generationConfig;
      if (model.startsWith("gemini-2.5")) {
        // Thinking is billed against the reply budget; spent in full it
        // returns a 200 with no parts, indistinguishable from silence.
        assert.equal(config.thinkingConfig?.thinkingBudget, 0, `${model} must not think`);
      } else {
        // 2.0 and 1.5 reject the field outright — a 400 on every request.
        assert.equal(config.thinkingConfig, undefined, `${model} must not be sent thinkingConfig`);
      }
      assert.ok(config.maxOutputTokens >= 2048, "the reply needs room");
    }
  });
});

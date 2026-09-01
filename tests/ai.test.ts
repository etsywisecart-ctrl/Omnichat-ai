import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_KEY ??= "test-key";
// Pin a 2.5 model ahead of the default so the thinkingConfig path is covered:
// the code offers that field to 2.5 only, and deliberately guesses no wider.
process.env.GEMINI_MODEL ??= "gemini-2.5-flash";

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

    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const href = String(url);
      if (href.includes(":generateContent")) {
        const model = href.split("/models/")[1].split(":")[0];
        seen.push({ model, body: JSON.parse(init!.body!) });
        // Fail every model so the loop walks the whole list.
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (href.includes("generativelanguage")) {
        // The model listing, consulted once every configured name has failed.
        return { ok: true, status: 200, json: async () => ({ models: [] }) };
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

describe("read-only mode", () => {
  test("refuses to place an order, and says so in words the model can relay", async () => {
    const { processToolCall } = await import("@/lib/ai/gemini");

    const outcome = await processToolCall(
      "biz-1",
      "create_order",
      { customer_name: "Test", items: [{ product_id: "p1", quantity: 1 }] },
      { readOnly: true }
    );

    // The live diagnostic runs the real tool declarations against a real
    // catalog. Without this guard, clicking "test the AI" could bill someone.
    assert.equal(outcome.success, false);
    assert.match(outcome.error ?? "", /no order was placed/i);
  });

  test("still allows the read-only tools through", async () => {
    const { processToolCall } = await import("@/lib/ai/gemini");

    const outcome = await processToolCall(
      "biz-1",
      "search_products",
      { query: "mug" },
      { readOnly: true }
    );

    assert.notEqual(outcome.error, "This is a configuration test, so no order was placed.");
  });
});

describe("surviving a model retirement", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("falls back to a model Google lists when every configured name is retired", async () => {
    const attempted: string[] = [];

    globalThis.fetch = (async (url: unknown) => {
      const href = String(url);

      if (href.includes(":generateContent")) {
        const model = href.split("/models/")[1].split(":")[0];
        attempted.push(model);

        // The exact failure that took this app down: the shipped names are
        // retired, and only a model discovered at runtime still answers.
        if (model === "gemini-9.9-flash") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              candidates: [{ content: { parts: [{ text: "We sell mugs." }] } }],
            }),
          };
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({
            error: { message: `${model} is no longer available to new users.` },
          }),
        };
      }

      if (href.includes("generativelanguage")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
              { name: "models/gemini-9.9-flash", supportedGenerationMethods: ["generateContent"] },
              { name: "models/gemini-4.0-pro", supportedGenerationMethods: ["generateContent"] },
            ],
          }),
        };
      }

      return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
    }) as unknown as typeof fetch;

    const { generateCustomerReply, GEMINI_MODELS } = await import("@/lib/ai/gemini");
    const reply = await generateCustomerReply("biz-1", "what do you sell?", [], {
      allowTools: false,
    });

    // A retirement should cost one slow reply, not an outage.
    assert.equal(reply.source, "gemini");
    assert.equal(reply.model, "gemini-9.9-flash");

    for (const configured of GEMINI_MODELS) {
      assert.ok(attempted.includes(configured), `${configured} must be tried first`);
    }
    // Newest flash beats an older pro, and an embedding model is never a
    // candidate for answering a customer.
    assert.ok(!attempted.includes("text-embedding-004"));
    assert.ok(
      attempted.indexOf("gemini-9.9-flash") < (attempted.indexOf("gemini-4.0-pro") + 1 || Infinity)
    );
  });

  test("retries without thinkingConfig when a model rejects it", async () => {
    const bodies: Array<Record<string, any>> = [];

    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const href = String(url);
      if (href.includes(":generateContent")) {
        const body = JSON.parse(init!.body!);
        bodies.push(body);

        if (body.generationConfig?.thinkingConfig) {
          return {
            ok: false,
            status: 400,
            json: async () => ({
              error: { message: "thinkingConfig is not supported for this model" },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ candidates: [{ content: { parts: [{ text: "Hello." }] } }] }),
        };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
    }) as unknown as typeof fetch;

    const { generateCustomerReply } = await import("@/lib/ai/gemini");
    const reply = await generateCustomerReply("biz-1", "hi", [], { allowTools: false });

    // Losing a customer's answer over a tuning parameter would be absurd.
    assert.equal(reply.source, "gemini");
    assert.ok(bodies.length >= 2, "must have retried");
    assert.ok(bodies[0].generationConfig.thinkingConfig, "the first try carries the field");
    assert.equal(
      bodies[1].generationConfig.thinkingConfig,
      undefined,
      "the retry must drop the field Google objected to"
    );
  });
});

describe("running out of quota", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Google's real 429 body, shape and prose intact. */
  const QUOTA_429 = {
    error: {
      message:
        "You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash Please retry in 18.08755195s.",
      details: [
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "18s" },
      ],
    },
  };

  test("does not spend the rest of the allowance hunting for another model", async () => {
    let generateCalls = 0;
    let listingCalls = 0;

    globalThis.fetch = (async (url: unknown) => {
      const href = String(url);
      if (href.includes(":generateContent")) {
        generateCalls++;
        return { ok: false, status: 429, json: async () => QUOTA_429 };
      }
      if (href.includes("generativelanguage")) {
        listingCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              { name: "models/gemini-9.9-flash", supportedGenerationMethods: ["generateContent"] },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
    }) as unknown as typeof fetch;

    const { generateCustomerReply, GEMINI_MODELS } = await import("@/lib/ai/gemini");
    const reply = await generateCustomerReply("biz-1", "hello?", []);

    // Every model on a key shares one free-tier bucket. Trying more of them
    // during a rate limit spends the allowance real customers need.
    assert.equal(generateCalls, GEMINI_MODELS.length, "must not try extra models");
    assert.equal(listingCalls, 0, "must not even ask for the model list");
  });

  test("says how long to wait, in words a shop owner can act on", async () => {
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes(":generateContent")) {
        return { ok: false, status: 429, json: async () => QUOTA_429 };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
    }) as unknown as typeof fetch;

    const { generateCustomerReply } = await import("@/lib/ai/gemini");
    const reply = await generateCustomerReply("biz-1", "hello?", []);

    assert.match(reply.reason!, /rate-limited by Google's free tier/);
    assert.match(reply.reason!, /20 requests\/minute/);
    assert.match(reply.reason!, /18s/);
    // Waiting is the fix; the reason must not send anyone hunting for a setting.
    assert.match(reply.reason!, /Waiting is the fix/);
  });

  test("still tries other models when a name is genuinely dead", async () => {
    const attempted: string[] = [];

    globalThis.fetch = (async (url: unknown) => {
      const href = String(url);
      if (href.includes(":generateContent")) {
        const model = href.split("/models/")[1].split(":")[0];
        attempted.push(model);
        if (model === "gemini-9.9-flash") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              candidates: [{ content: { parts: [{ text: "We sell mugs." }] } }],
            }),
          };
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: { message: `${model} is not found` } }),
        };
      }
      if (href.includes("generativelanguage")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              { name: "models/gemini-9.9-flash", supportedGenerationMethods: ["generateContent"] },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
    }) as unknown as typeof fetch;

    const { generateCustomerReply } = await import("@/lib/ai/gemini");
    const reply = await generateCustomerReply("biz-1", "hi", [], { allowTools: false });

    // A 404 is about this model, not the allowance — recovery is still right.
    assert.equal(reply.source, "gemini");
    assert.ok(attempted.includes("gemini-9.9-flash"));
  });
});

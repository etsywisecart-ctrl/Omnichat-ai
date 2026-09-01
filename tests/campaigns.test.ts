import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { sendWhatsAppTemplate } from "@/lib/channels/whatsapp";

const realFetch = globalThis.fetch;

/** Capture the request Meta would have received. */
function captureGraph(response: { ok: boolean; status: number; body: unknown }) {
  const calls: Array<{ url: string; body: any }> = [];

  globalThis.fetch = (async (url: unknown, init: { body: string }) => ({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
    text: async () => JSON.stringify(response.body),
    ...(calls.push({ url: String(url), body: JSON.parse(init.body) }) ? {} : {}),
  })) as unknown as typeof fetch;

  return calls;
}

describe("WhatsApp template sending", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const credentials = { phoneNumberId: "123", accessToken: "tok" };

  test("sends a template, not free text, because a broadcast is outside the 24h window", async () => {
    const calls = captureGraph({ ok: true, status: 200, body: { messages: [{ id: "wamid.1" }] } });

    const result = await sendWhatsAppTemplate({
      to: "+1 (555) 010-9999",
      templateName: "cart_reminder",
      languageCode: "en_US",
      variables: ["Blue Mug"],
      ...credentials,
    });

    assert.equal(result.success, true);
    assert.equal(result.messageId, "wamid.1");

    const sent = calls[0].body;
    // Meta rejects type:"text" outside the service window — the whole reason
    // campaigns could be queued but never delivered.
    assert.equal(sent.type, "template");
    assert.equal(sent.template.name, "cart_reminder");
    assert.equal(sent.template.language.code, "en_US");
    assert.deepEqual(sent.template.components, [
      { type: "body", parameters: [{ type: "text", text: "Blue Mug" }] },
    ]);
    // Meta wants digits only.
    assert.equal(sent.to, "15550109999");
  });

  test("omits components entirely when the template takes no variables", async () => {
    const calls = captureGraph({ ok: true, status: 200, body: { messages: [{ id: "x" }] } });

    await sendWhatsAppTemplate({ to: "15551234567", templateName: "hello", ...credentials });

    // An empty components array is rejected by templates that take no
    // parameters, so the key must be absent rather than present and empty.
    assert.equal("components" in calls[0].body.template, false);
  });

  test("surfaces the nested detail Meta hides under a generic message", async () => {
    captureGraph({
      ok: false,
      status: 400,
      body: {
        error: {
          message: "(#132001) Template name does not exist",
          error_data: { details: "template name (cart_reminder) does not exist in en_US" },
        },
      },
    });

    const result = await sendWhatsAppTemplate({
      to: "15551234567",
      templateName: "cart_reminder",
      ...credentials,
    });

    assert.equal(result.success, false);
    // The outer message alone never names the language mismatch, which is the
    // single most common reason a template send fails.
    assert.match(result.error!, /Template name does not exist/);
    assert.match(result.error!, /does not exist in en_US/);
  });

  test("refuses before calling Meta when there is no template or no credentials", async () => {
    const calls = captureGraph({ ok: true, status: 200, body: {} });

    const noTemplate = await sendWhatsAppTemplate({
      to: "15551234567",
      templateName: "",
      ...credentials,
    });
    const noCredentials = await sendWhatsAppTemplate({
      to: "15551234567",
      templateName: "hello",
      phoneNumberId: "",
      accessToken: "",
    });

    assert.equal(noTemplate.success, false);
    assert.equal(noCredentials.success, false);
    assert.equal(calls.length, 0, "must not spend a Graph call to learn this");
  });
});

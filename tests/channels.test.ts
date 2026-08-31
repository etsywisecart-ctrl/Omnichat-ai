import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isWithinSessionWindow, sendToChannel } from "@/lib/channels/registry";
import { verifyMetaSignature, verifyHubToken } from "@/lib/channels/verify";
import crypto from "node:crypto";

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("session window", () => {
  test("free-form replies are allowed inside 24 hours", () => {
    assert.equal(isWithinSessionWindow("whatsapp", ago(HOUR)), true);
    assert.equal(isWithinSessionWindow("whatsapp", ago(23 * HOUR)), true);
  });

  test("free-form replies are blocked after 24 hours", () => {
    assert.equal(isWithinSessionWindow("whatsapp", ago(25 * HOUR)), false);
    assert.equal(isWithinSessionWindow("instagram", ago(30 * HOUR)), false);
  });

  test("a customer who never wrote cannot be messaged free-form", () => {
    assert.equal(isWithinSessionWindow("whatsapp", null), false);
    assert.equal(isWithinSessionWindow("whatsapp", undefined), false);
  });

  test("the web widget has no such window", () => {
    assert.equal(isWithinSessionWindow("web", null), true);
  });
});

describe("channel dispatch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("refuses, with a reason, when the channel isn't connected", async () => {
    const r = await sendToChannel("whatsapp", "123", "hi", null);
    assert.equal(r.success, false);
    assert.match(r.error ?? "", /isn't connected/);
  });

  test("refuses when required credentials are missing", async () => {
    const wa = await sendToChannel("whatsapp", "1", "hi", {
      channel_type: "whatsapp",
      access_token: "tok",
    });
    assert.equal(wa.success, false, "whatsapp needs a phone_number_id");

    const ms = await sendToChannel("messenger", "1", "hi", {
      channel_type: "messenger",
      access_token: "tok",
    });
    assert.equal(ms.success, false, "messenger needs a page_id");
  });

  test("refuses an unknown channel rather than silently doing nothing", async () => {
    const r = await sendToChannel("carrier-pigeon", "1", "hi", {
      channel_type: "carrier-pigeon",
      access_token: "tok",
    });
    assert.equal(r.success, false);
  });

  test("a provider rejection is reported as failure", async () => {
    // This is what stops a message being recorded that the customer never got.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid recipient"}',
    })) as unknown as typeof fetch;

    const r = await sendToChannel("whatsapp", "1", "hi", {
      channel_type: "whatsapp",
      access_token: "tok",
      phone_number_id: "pn1",
    });
    assert.equal(r.success, false);
  });

  test("a successful send returns the provider message id", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: "wamid.123" }] }),
    })) as unknown as typeof fetch;

    const r = await sendToChannel("whatsapp", "1", "hi", {
      channel_type: "whatsapp",
      access_token: "tok",
      phone_number_id: "pn1",
    });
    assert.equal(r.success, true);
    assert.equal(r.messageId, "wamid.123");
  });
});

describe("webhook signature verification", () => {
  const secret = "app-secret";
  const body = '{"entry":[]}';
  const good = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

  test("accepts a correct signature", () => {
    assert.equal(verifyMetaSignature(body, good, secret), true);
  });

  test("rejects a tampered body", () => {
    assert.equal(verifyMetaSignature('{"entry":[1]}', good, secret), false);
  });

  test("FAILS CLOSED when no app secret is configured", () => {
    // The original returned true here, so a typo'd env var silently disabled
    // webhook authentication entirely.
    assert.equal(verifyMetaSignature(body, good, ""), false);
  });

  test("rejects a malformed or missing signature header", () => {
    assert.equal(verifyMetaSignature(body, "", secret), false);
    assert.equal(verifyMetaSignature(body, "md5=abc", secret), false);
  });

  test("hub verify token rejects when unset or mismatched", () => {
    assert.equal(verifyHubToken("abc", undefined), false);
    assert.equal(verifyHubToken(null, "abc"), false);
    assert.equal(verifyHubToken("abc", "abd"), false);
    assert.equal(verifyHubToken("abc", "abc"), true);
  });
});

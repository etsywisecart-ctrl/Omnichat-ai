import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * The quota is what makes a second customer possible: every shop on this
 * deployment answers through one AI key with one allowance.
 */
describe("monthly reply allowance", () => {
  test("counts this month's bot replies against the shop's own limit", async () => {
    const { replyUsage } = await import("@/lib/billing/quota");

    // The counting is done in the database; this pins the arithmetic and the
    // month boundary the count is taken from.
    const usage = await replyUsage("00000000-0000-0000-0000-000000000000");

    assert.equal(typeof usage.used, "number");
    assert.equal(typeof usage.limit, "number");
    assert.equal(usage.remaining, Math.max(0, usage.limit - usage.used));
    assert.equal(usage.exceeded, usage.used >= usage.limit);

    // Resets on the first of the month, in UTC, so two shops in different
    // timezones are not billed against different calendars.
    const since = new Date(usage.since);
    assert.equal(since.getUTCDate(), 1);
    assert.equal(since.getUTCHours(), 0);
    assert.equal(since.getUTCMinutes(), 0);
  });

  test("a shop with no plan row is limited, not unlimited", async () => {
    const { replyUsage } = await import("@/lib/billing/quota");

    // Failing open on a shared quota is how one shop drains every other one.
    const usage = await replyUsage("00000000-0000-0000-0000-000000000000");
    assert.ok(usage.limit > 0, "there must always be a ceiling");
    assert.ok(Number.isFinite(usage.limit));
  });
});

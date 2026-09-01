import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { originAllowed } from "@/lib/channels/web";

describe("widget origin allowlist", () => {
  test("an empty list embeds anywhere, which is the honest default", () => {
    // The widget's entire purpose is to be embedded, and a shop that has not
    // configured domains should not be silently broken. Rate limits, not this
    // list, are what stop abuse.
    assert.equal(originAllowed("https://anyshop.com", []), true);
    assert.equal(originAllowed(null, []), true);
  });

  test("matches an exact origin, ignoring a trailing slash and case", () => {
    assert.equal(originAllowed("https://shop.com", ["https://shop.com"]), true);
    assert.equal(originAllowed("https://shop.com/", ["https://shop.com"]), true);
    assert.equal(originAllowed("https://SHOP.com", ["https://shop.com"]), true);
  });

  test("refuses an origin that is not on a non-empty list", () => {
    assert.equal(originAllowed("https://evil.com", ["https://shop.com"]), false);
    // No Origin header at all cannot satisfy a specific allowlist.
    assert.equal(originAllowed(null, ["https://shop.com"]), false);
  });

  test("a wildcard covers subdomains without covering an impostor", () => {
    assert.equal(originAllowed("https://www.shop.com", ["https://*.shop.com"]), true);
    assert.equal(originAllowed("https://checkout.shop.com", ["https://*.shop.com"]), true);

    // The attack this guards against: a domain that merely *contains* the
    // shop's name. A greedy wildcard would wave both of these through.
    assert.equal(originAllowed("https://shop.com.evil.net", ["https://*.shop.com"]), false);
    assert.equal(originAllowed("https://a.b.shop.com.evil.net", ["https://*.shop.com"]), false);
  });

  test("does not treat a dot in the pattern as 'any character'", () => {
    // "shopXcom" must not satisfy "shop.com" — a raw regex would allow it.
    assert.equal(originAllowed("https://shopXcom", ["https://shop.com"]), false);
  });

  test("honours an explicit open wildcard", () => {
    assert.equal(originAllowed("https://anywhere.com", ["*"]), true);
  });

  test("ignores blank lines left behind in the settings box", () => {
    assert.equal(originAllowed("https://shop.com", ["", "   ", "https://shop.com"]), true);
    assert.equal(originAllowed("https://evil.com", ["", "https://shop.com"]), false);
  });
});

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/widget/script?b=<business id> — the embeddable chat widget.
 *
 * Served as JavaScript rather than shipped as a file so the endpoint it talks
 * to is the deployment that served it. A snippet copied from a preview URL
 * would otherwise keep pointing at that preview after it is deleted.
 *
 * Everything is inline: no framework, no CSS file, no second request. A shop
 * owner pastes one tag into a theme they may not fully understand, so the
 * widget must not depend on anything about the page it lands on — hence the
 * shadow root, which stops the host site's CSS from reaching inside.
 */
export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("b") ?? "";
  const endpoint = `${request.nextUrl.origin}/api/widget/chat`;

  // Only ever interpolated into a JSON string literal, and both values are
  // ours or a UUID from the query — but JSON.stringify keeps a stray quote
  // from becoming syntax rather than data.
  const script = `(function () {
  "use strict";

  var BUSINESS_ID = ${JSON.stringify(businessId)};
  var ENDPOINT = ${JSON.stringify(endpoint)};
  if (!BUSINESS_ID) return;
  if (window.__omnichatWidgetLoaded) return;
  window.__omnichatWidgetLoaded = true;

  // One id per browser, so a visitor's thread survives a page navigation and
  // the shop sees one conversation instead of one per page view.
  var KEY = "omnichat.session." + BUSINESS_ID;
  var sessionId;
  try {
    sessionId = localStorage.getItem(KEY);
  } catch (e) {
    sessionId = null; // private mode: fall back to a per-page session
  }
  if (!sessionId) {
    sessionId = "web-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem(KEY, sessionId); } catch (e) {}
  }

  var host = document.createElement("div");
  host.style.cssText = "position:fixed;bottom:0;right:0;z-index:2147483647";
  document.body.appendChild(host);
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

  root.innerHTML =
    '<style>' +
    ':host,*{box-sizing:border-box}' +
    '.launch{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;border:0;' +
      'background:#0f766e;color:#fff;font-size:24px;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.24)}' +
    '.panel{position:fixed;bottom:88px;right:20px;width:340px;max-width:calc(100vw - 32px);height:460px;' +
      'max-height:calc(100vh - 120px);background:#fff;color:#111;border-radius:14px;display:none;' +
      'flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.26);' +
      'font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    '.panel.open{display:flex}' +
    '.head{background:#0f766e;color:#fff;padding:12px 14px;font-weight:600;display:flex;justify-content:space-between}' +
    '.head button{background:0;border:0;color:#fff;font-size:18px;cursor:pointer;line-height:1}' +
    '.log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}' +
    '.m{max-width:82%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}' +
    '.them{background:#f1f5f9;align-self:flex-start}' +
    '.you{background:#0f766e;color:#fff;align-self:flex-end}' +
    '.warn{align-self:center;color:#b91c1c;font-size:12px;text-align:center}' +
    '.bar{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb}' +
    '.bar input{flex:1;padding:9px 11px;border:1px solid #d1d5db;border-radius:8px;font:inherit;min-width:0}' +
    '.bar button{padding:9px 14px;border:0;border-radius:8px;background:#0f766e;color:#fff;cursor:pointer}' +
    '.bar button:disabled{opacity:.5;cursor:default}' +
    '</style>' +
    '<button class="launch" aria-label="Chat with us">&#128172;</button>' +
    '<div class="panel" role="dialog" aria-label="Chat">' +
      '<div class="head"><span>Chat with us</span><button class="x" aria-label="Close">&times;</button></div>' +
      '<div class="log"></div>' +
      '<form class="bar"><input placeholder="Ask about a product..." autocomplete="off" maxlength="1000">' +
      '<button type="submit">Send</button></form>' +
    '</div>';

  var launch = root.querySelector(".launch");
  var panel = root.querySelector(".panel");
  var log = root.querySelector(".log");
  var form = root.querySelector(".bar");
  var input = root.querySelector(".bar input");
  var send = root.querySelector(".bar button");
  var greeted = false;

  function add(text, cls) {
    var el = document.createElement("div");
    el.className = "m " + cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function toggle() {
    var open = panel.classList.toggle("open");
    if (open) {
      if (!greeted) { greeted = true; add("Hi! Ask me anything about our products.", "them"); }
      input.focus();
    }
  }

  launch.addEventListener("click", toggle);
  root.querySelector(".x").addEventListener("click", toggle);

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text) return;

    add(text, "you");
    input.value = "";
    input.disabled = send.disabled = true;
    var thinking = add("...", "them");

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: BUSINESS_ID, sessionId: sessionId, message: text })
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        thinking.remove();
        if (result.ok && result.data && result.data.reply) {
          add(result.data.reply, "them");
        } else {
          // Say what the server said. A widget that fails silently is the
          // reason this project spent days guessing at an invisible error.
          add((result.data && result.data.error) || "Something went wrong.", "warn");
        }
      })
      .catch(function () {
        thinking.remove();
        add("Couldn't reach the shop. Check your connection and try again.", "warn");
      })
      .finally(function () {
        input.disabled = send.disabled = false;
        input.focus();
      });
  });
})();`;

  return new NextResponse(script, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Short: the shop edits its allowed origins and expects that to matter
      // soon, but every page view should not rebuild this.
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

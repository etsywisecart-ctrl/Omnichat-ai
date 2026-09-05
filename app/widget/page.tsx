"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useBusinessGate } from "@/hooks/useCurrentBusinessId";
import { supabase } from "@/lib/supabase/client";
import { LoadingState, NotConnectedNotice } from "@/components/State";

/**
 * Put the agent on the shop's own website.
 *
 * The only channel that needs nobody's approval — no Meta review, no business
 * verification, no 24-hour reply window. One script tag and the same AI that
 * answers on WhatsApp answers on the shop's storefront, into the same Inbox.
 */
export default function WidgetPage() {
  const { session, businessId, loading: gateLoading, missing } = useBusinessGate();

  const [enabled, setEnabled] = useState(false);
  const [origins, setOrigins] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const snippet = useMemo(() => {
    if (!businessId) return "";
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    return `<script src="${origin}/api/widget/script?b=${businessId}" async></script>`;
  }, [businessId]);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;

    (async () => {
      const { data, error: readError } = await supabase
        .from("channel_connections")
        .select("status, config")
        .eq("business_id", businessId)
        .eq("channel_type", "web")
        .maybeSingle();

      if (cancelled) return;
      if (readError) setError(readError.message);

      const config = (data?.config ?? {}) as { allowed_origins?: string[] };
      setEnabled(Boolean(data) && data!.status !== "not_connected");
      setOrigins((config.allowed_origins ?? []).join("\n"));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const save = async (nextEnabled: boolean) => {
    if (!businessId) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    const allowed = origins
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const { error: writeError } = await supabase.from("channel_connections").upsert(
      {
        business_id: businessId,
        channel_type: "web",
        status: nextEnabled ? "connected" : "not_connected",
        config: { allowed_origins: allowed },
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "business_id,channel_type" }
    );

    if (writeError) setError(writeError.message);
    else {
      setEnabled(nextEnabled);
      setSaved(true);
    }
    setSaving(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy — select the code and copy it manually.");
    }
  };

  if (gateLoading) return <LoadingState />;

  return (
    <div className="app">
      <div className="wrap" style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
        <h1 className="fs20 fw7" style={{ marginBottom: 4 }}>
          Chat on your own website
        </h1>
        <p className="mut fs12" style={{ marginBottom: 14 }}>
          The same agent that answers on WhatsApp, on your storefront. No Meta approval needed, and
          replies land in the same Inbox.
        </p>

        <div className="fx ac gap8 wrap" style={{ marginBottom: 12 }}>
          <Link href="/" className="btn">
            Back to dashboard
          </Link>
          <Link href="/playground" className="btn">
            Test the agent
          </Link>
        </div>

        {!session && (
          <div className="notice">
            <Link href="/login">Sign in</Link> to set up the widget.
          </div>
        )}
        {missing && <NotConnectedNotice />}

        {session && businessId && !loading && (
          <>
            <div className="card" style={{ padding: 16, marginBottom: 12 }}>
              <div className="fx ac gap8 wrap">
                <span className={enabled ? "bdg ok" : "bdg warn"}>
                  {enabled ? "Widget is on" : "Widget is off"}
                </span>
                <button className="btn" onClick={() => save(!enabled)} disabled={saving}>
                  {saving ? "Saving…" : enabled ? "Turn it off" : "Turn it on"}
                </button>
              </div>
              <p className="mut fs12" style={{ marginTop: 10 }}>
                While it&rsquo;s off the script does nothing, so you can paste it into your site
                before you&rsquo;re ready to go live.
              </p>
            </div>

            <div className="card" style={{ padding: 16, marginBottom: 12 }}>
              <div className="flab" style={{ marginBottom: 6 }}>
                Paste this into your website, just before &lt;/body&gt;
              </div>
              <pre
                className="mono fs12"
                style={{
                  background: "var(--bg2, #f6f7f9)",
                  padding: 12,
                  borderRadius: 8,
                  overflowX: "auto",
                  marginBottom: 10,
                }}
              >
                {snippet}
              </pre>
              <button className="btn" onClick={copy}>
                {copied ? "Copied" : "Copy the code"}
              </button>
              <p className="mut fs12" style={{ marginTop: 10 }}>
                On Shopify: Online Store → Themes → Edit code → <span className="mono">theme.liquid</span>.
                On most site builders, look for a &ldquo;custom code&rdquo; or &ldquo;footer
                scripts&rdquo; box.
              </p>
            </div>

            <div className="card" style={{ padding: 16 }}>
              <div className="flab" style={{ marginBottom: 6 }}>
                Websites allowed to use it (one per line)
              </div>
              <textarea
                className="inp w100"
                rows={4}
                value={origins}
                onChange={(e) => setOrigins(e.target.value)}
                placeholder={"https://yourshop.com\nhttps://*.yourshop.com"}
                style={{ fontFamily: "monospace", fontSize: 12 }}
              />
              <p className="mut fs12" style={{ margin: "10px 0" }}>
                Leave this empty and any site may embed the widget. Listing your own domains means
                nobody else can put your agent — and your AI usage — on their page.
              </p>
              <button className="btn" onClick={() => save(enabled)} disabled={saving}>
                {saving ? "Saving…" : "Save websites"}
              </button>
            </div>

            {saved && (
              <p className="mut fs12" style={{ marginTop: 10 }}>
                Saved.
              </p>
            )}
            {error && (
              <p className="fs12" style={{ color: "var(--err)", marginTop: 10 }}>
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

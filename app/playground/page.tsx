"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "@/hooks/useSession";
import { useCurrentBusinessId } from "@/hooks/useCurrentBusinessId";
import { useDashboardStore, isDark } from "@/store/useDashboardStore";
import { supabase } from "@/lib/supabase/client";
import { LoadingState, NotConnectedNotice } from "@/components/State";

interface Turn {
  sender: "customer" | "bot";
  text: string;
  /** Debug detail, shown under bot turns so you can see how the answer came about. */
  source?: string;
  model?: string | null;
  tools?: Array<{ name: string; ok?: boolean }>;
  /** Operator-facing explanation of a fallback, e.g. a missing API key. */
  reason?: string | null;
}

interface Diagnostics {
  healthy: boolean;
  summary: string;
  checks: Array<{ name: string; ok: boolean; detail: string; fix?: string }>;
  reminder: string;
}

const SOURCE_LABEL: Record<string, { text: string; cls: string }> = {
  gemini: { text: "Gemini", cls: "bdg ok" },
  catalog: { text: "Catalog fallback", cls: "bdg warn" },
  error: { text: "Unavailable", cls: "bdg err" },
};

/**
 * Talk to your own AI agent, exactly as a customer would.
 *
 * Deliberately shows how each answer was produced — which model replied, which
 * tools ran, or whether it fell back to a plain catalog lookup. That is the
 * difference between "the bot said something" and knowing it actually reached
 * Gemini and searched your real products.
 */
export default function Playground() {
  const { session, loading: sessionLoading } = useSession();
  const { data: businessId, isLoading: bizLoading } = useCurrentBusinessId();
  const themeOverride = useDashboardStore((s) => s.themeOverride);
  const sysDark = useDashboardStore((s) => s.sysDark);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // The diagnostics endpoint needs the caller's token, so it can't just be
  // opened in the address bar. Running it from here keeps it one click away.
  const runDiagnostics = async () => {
    setDiagBusy(true);
    setDiagError(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Sign in first");

      const res = await fetch("/api/diagnostics", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.message ?? `Diagnostics returned ${res.status}`);
      setDiag(payload as Diagnostics);
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : "Couldn't run the check");
    } finally {
      setDiagBusy(false);
    }
  };

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, busy]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;

    setError(null);
    setBusy(true);
    setDraft("");

    const history = turns.map((t) => ({ sender: t.sender, text: t.text }));
    setTurns((prev) => [...prev, { sender: "customer", text: message }]);

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_id: businessId, message, history }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok && !data?.reply) {
        throw new Error(data?.error ?? `The chat endpoint returned ${res.status}`);
      }

      setTurns((prev) => [
        ...prev,
        {
          sender: "bot",
          text: data?.reply ?? data?.text ?? "(empty reply)",
          source: data?.source,
          model: data?.model,
          tools: data?.toolsUsed,
          reason: data?.reason,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach the AI");
    } finally {
      setBusy(false);
    }
  };

  const dark = isDark({ themeOverride, sysDark });

  if (sessionLoading || bizLoading) {
    return (
      <div className={"app" + (dark ? " dark" : "")}>
        <div className="f1" style={{ padding: 24 }}>
          <LoadingState rows={3} />
        </div>
      </div>
    );
  }

  return (
    <div className={"app" + (dark ? " dark" : "")} style={{ overflow: "auto" }}>
      <div className="page" style={{ maxWidth: 760 }}>
        <div className="phead">
          <div>
            <h1 className="h1">Try your agent</h1>
            <p className="sub">
              The same AI that answers on WhatsApp, Instagram and Messenger — ask it what a
              customer would.
            </p>
          </div>
          <Link href="/" className="btn">
            Back to dashboard
          </Link>
        </div>

        {!session && (
          <div className="notice">
            <Link href="/login">Sign in</Link> to use the playground.
          </div>
        )}
        {session && !businessId && <NotConnectedNotice />}

        <div className="card" style={{ marginTop: 12, padding: 14 }}>
          <div className="fx ac gap8 wrap">
            <button className="btn" onClick={runDiagnostics} disabled={diagBusy || !session}>
              {diagBusy ? "Checking…" : "Check setup"}
            </button>
            <span className="mut fs12">
              Reports which keys are actually working, so a silent AI resolves to one named setting.
            </span>
          </div>

          {diagError && (
            <div className="mut fs12" style={{ color: "var(--err)", marginTop: 10 }}>
              {diagError}
            </div>
          )}

          {diag && (
            <div style={{ marginTop: 12 }}>
              <div className={diag.healthy ? "bdg ok" : "bdg err"}>{diag.summary}</div>
              <ul className="mut fs12" style={{ marginTop: 10, paddingLeft: 18 }}>
                {diag.checks.map((c) => (
                  <li key={c.name} style={{ marginBottom: 6 }}>
                    <span style={{ marginRight: 6 }}>{c.ok ? "✓" : "✕"}</span>
                    <strong>{c.name}</strong> — {c.detail}
                    {c.fix && (
                      <div style={{ marginTop: 2 }}>
                        <em>Fix: {c.fix}</em>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mut fs12">{diag.reminder}</p>
            </div>
          )}
        </div>

        <div className="card" style={{ marginTop: 12 }}>
          <div className="mlist" style={{ minHeight: 320, maxHeight: 460, overflow: "auto" }}>
            {turns.length === 0 && (
              <div className="empty">
                <div className="empty-ic">💬</div>
                <div className="fw6 fs14">Ask about a product</div>
                <div className="mut fs12 mt2" style={{ maxWidth: 380, textAlign: "center" }}>
                  Upload your catalog first, then try something like &ldquo;do you have a blue
                  mug?&rdquo; or &ldquo;what&rsquo;s your cheapest item?&rdquo;
                </div>
              </div>
            )}

            {turns.map((t, i) => {
              const isCustomer = t.sender === "customer";
              const badge = t.source ? SOURCE_LABEL[t.source] : null;
              return (
                <div className={"mrow " + (isCustomer ? "r" : "l")} key={i}>
                  <div className={"msg " + (isCustomer ? "agent" : "cust")}>{t.text}</div>
                  <div className="mmeta fx ac gap8 wrap">
                    <span>{isCustomer ? "You" : "AI agent"}</span>
                    {badge && <span className={badge.cls}>{badge.text}</span>}
                    {t.model && <span className="ftag">{t.model}</span>}
                    {t.tools?.map((tool, j) => (
                      <span className="ftag" key={j}>
                        {tool.name}
                        {tool.ok === false ? " ✕" : " ✓"}
                      </span>
                    ))}
                  </div>
                  {t.reason && (
                    <div className="mmeta mut fs12" style={{ maxWidth: 460 }}>
                      {t.reason}
                    </div>
                  )}
                </div>
              );
            })}

            {busy && (
              <div className="mrow l">
                <div className="msg cust mut">Thinking…</div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form className="composer" onSubmit={send}>
            {error && (
              <div className="mut fs12" style={{ color: "var(--err)", marginBottom: 8 }}>
                {error}
              </div>
            )}
            <div className="fx gap8 ac">
              <input
                className="inp f1"
                placeholder="Ask about a product…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={busy || !businessId}
                aria-label="Your message"
              />
              <button className="btn-p" type="submit" disabled={busy || !draft.trim() || !businessId}>
                {busy ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        </div>

        <p className="mut fs12" style={{ marginTop: 12 }}>
          The tags under each reply show how it was produced: which model answered, and which
          tools it ran against your catalog. A <span className="bdg warn">Catalog fallback</span>{" "}
          badge means Gemini was unreachable and the answer came straight from your products
          table.
        </p>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useBusinessGate } from "@/hooks/useCurrentBusinessId";
import { freshAccessToken } from "@/lib/supabase/session";
import { LoadingState, NotConnectedNotice } from "@/components/State";

/**
 * Connect WhatsApp, Messenger or Instagram.
 *
 * Meta's own setup is the slow part and none of it is ours to remove — a
 * business account, a verified number, an app. What this page removes is the
 * part we caused: assembling by hand the two values Meta asks for, which is
 * where a connection quietly ends up pointing at nothing.
 */

type Channel = "whatsapp" | "messenger" | "instagram";

const LABEL: Record<Channel, string> = {
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
};

const ACCOUNT_LABEL: Record<Channel, string> = {
  whatsapp: "Phone number ID",
  messenger: "Facebook Page ID",
  instagram: "Instagram account ID",
};

const WHERE: Record<Channel, string> = {
  whatsapp:
    "Meta for Developers → your app → WhatsApp → API Setup. The temporary token shown there is fine for testing; a permanent one comes from a System User.",
  messenger:
    "Meta for Developers → your app → Messenger → Settings → generate a Page access token for your Page.",
  instagram:
    "Meta for Developers → your app → Instagram → generate a token for the Instagram account linked to your Page.",
};

interface Connected {
  channelType: Channel;
  status: string;
  token: string | null;
  verifyToken: string | null;
  accountId: string | null;
}

async function call(path: string, init: RequestInit = {}) {
  const token = await freshAccessToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "That didn't work.");
  return payload;
}

export default function ChannelsSetup() {
  const { session, businessId, loading, missing } = useBusinessGate();

  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [connected, setConnected] = useState<Connected[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ accessToken: "", appSecret: "", accountId: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await call("/api/channels/connect");
      setConnected(payload.channels as Connected[]);
      setUrls(payload.webhookUrls as Record<string, string>);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load your channels.");
    }
  }, []);

  useEffect(() => {
    if (businessId) void load();
  }, [businessId, load]);

  const current = connected.find((c) => c.channelType === channel);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload = await call("/api/channels/connect", {
        method: "POST",
        body: JSON.stringify({ channelType: channel, ...form }),
      });
      setNotice(payload.message as string);
      setForm({ accessToken: "", appSecret: "", accountId: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setError(null);
    try {
      await call(`/api/channels/connect?channelType=${channel}`, { method: "DELETE" });
      setNotice(`${LABEL[channel]} disconnected.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't disconnect.");
    }
  };

  if (loading) return <LoadingState />;

  const box = {
    background: "var(--bg2,#f6f7f9)",
    padding: 10,
    borderRadius: 8,
    overflowX: "auto" as const,
  };

  return (
    <div className="app">
      <div style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
        <h1 className="fs20 fw7" style={{ marginBottom: 4 }}>
          Connect WhatsApp, Messenger or Instagram
        </h1>
        <p className="mut fs12" style={{ marginBottom: 14 }}>
          The same agent that answers on your website, answering in Meta&rsquo;s apps. Replies land
          in the same Inbox.
        </p>

        <div className="fx ac gap8 wrap" style={{ marginBottom: 12 }}>
          <Link href="/" className="btn">
            Back to dashboard
          </Link>
        </div>

        {!session && (
          <div className="notice">
            <Link href="/login">Sign in</Link> to connect a channel.
          </div>
        )}
        {missing && <NotConnectedNotice />}

        {session && businessId && (
          <>
            <div className="fx ac gap8 wrap" style={{ marginBottom: 12 }}>
              {(Object.keys(LABEL) as Channel[]).map((key) => (
                <button
                  key={key}
                  className={channel === key ? "btn-p" : "btn"}
                  onClick={() => setChannel(key)}
                >
                  {LABEL[key]} {connected.some((c) => c.channelType === key) ? "✓" : ""}
                </button>
              ))}
            </div>

            {current && (
              <div className="card" style={{ padding: 16, marginBottom: 12 }}>
                <div className="fx ac gap8 wrap" style={{ marginBottom: 10 }}>
                  <span className="bdg ok">{LABEL[channel]} connected</span>
                  <span className="mut fs12 mono">{current.accountId}</span>
                </div>
                <p className="mut fs12" style={{ marginBottom: 10 }}>
                  Token {current.token}
                </p>
                <button className="btn" onClick={disconnect}>
                  Disconnect
                </button>
              </div>
            )}

            <form className="card" style={{ padding: 16 }} onSubmit={save}>
              <div className="flab" style={{ marginBottom: 6 }}>
                Step 1 — paste these from Meta
              </div>
              <p className="mut fs12" style={{ marginBottom: 12 }}>
                {WHERE[channel]}
              </p>

              <input
                className="inp w100"
                style={{ marginBottom: 10 }}
                placeholder={ACCOUNT_LABEL[channel]}
                required
                value={form.accountId}
                onChange={(e) => setForm({ ...form, accountId: e.target.value })}
              />
              <input
                className="inp w100"
                style={{ marginBottom: 10 }}
                type="password"
                placeholder="Access token"
                required
                value={form.accessToken}
                onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
              />
              <input
                className="inp w100"
                style={{ marginBottom: 10 }}
                type="password"
                placeholder="App secret (Settings → Basic → App Secret)"
                value={form.appSecret}
                onChange={(e) => setForm({ ...form, appSecret: e.target.value })}
              />
              <button className="btn-p" type="submit" disabled={busy}>
                {busy ? "Saving…" : current ? "Update credentials" : "Save credentials"}
              </button>
              <p className="mut fs12" style={{ marginTop: 10 }}>
                The app secret is how a message is proved to have come from Meta. Without it,
                incoming messages are rejected rather than trusted.
              </p>
            </form>

            {current?.verifyToken && (
              <div className="card" style={{ padding: 16, marginTop: 12 }}>
                <div className="flab" style={{ marginBottom: 6 }}>
                  Step 2 — paste these back into Meta
                </div>
                <p className="mut fs12" style={{ marginBottom: 10 }}>
                  Meta for Developers → your app → {LABEL[channel]} → Configuration → Webhook →
                  Edit. Then subscribe to <span className="mono">messages</span>.
                </p>

                <div className="flab" style={{ marginBottom: 4 }}>
                  Callback URL
                </div>
                <pre className="mono fs12" style={box}>
                  {urls[channel]}
                </pre>

                <div className="flab" style={{ margin: "10px 0 4px" }}>
                  Verify token
                </div>
                <pre className="mono fs12" style={box}>
                  {current.verifyToken}
                </pre>

                <p className="mut fs12" style={{ marginTop: 10 }}>
                  This token is yours alone — it is how a delivery from Meta is matched to your
                  shop rather than to somebody else&rsquo;s.
                </p>
              </div>
            )}

            {notice && (
              <p className="mut fs12" style={{ marginTop: 10 }}>
                {notice}
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

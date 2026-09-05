"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/hooks/useSession";
import { useCurrentBusinessId } from "@/hooks/useCurrentBusinessId";
import { supabase } from "@/lib/supabase/client";
import { LoadingState, NotConnectedNotice } from "@/components/State";

/**
 * Connect the shop's real store, so the catalog keeps itself up to date.
 *
 * Both providers use credentials the owner issues from their own admin rather
 * than an OAuth app: a custom-app token on Shopify, a read-only key pair on
 * WooCommerce. That takes about two minutes and no approval from anyone, where
 * a public app would mean a Partner account and a review before a shop owner
 * could see their own products.
 */

interface Status {
  connected: boolean;
  provider?: "shopify" | "woocommerce";
  storeUrl?: string;
  credential?: string | null;
  lastSyncedAt?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  lastImported?: number;
  lastDeactivated?: number;
}

async function authorisedFetch(path: string, init: RequestInit = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in first.");

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

function whenever(iso: string | null | undefined): string {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} day(s) ago`;
}

export default function StoresPage() {
  const { session, loading: sessionLoading } = useSession();
  const { data: businessId, isLoading: bizLoading } = useCurrentBusinessId();

  const [status, setStatus] = useState<Status | null>(null);
  const [provider, setProvider] = useState<"shopify" | "woocommerce">("shopify");
  const [storeUrl, setStoreUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [busy, setBusy] = useState<false | "connect" | "sync" | "disconnect">(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus((await authorisedFetch("/api/stores")) as Status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load your store connection.");
    }
  }, []);

  useEffect(() => {
    if (businessId) void load();
  }, [businessId, load]);

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("connect");
    setError(null);
    setMessage(null);
    try {
      const result = await authorisedFetch("/api/stores", {
        method: "POST",
        body: JSON.stringify({ provider, storeUrl, accessToken, consumerKey, consumerSecret }),
      });
      // Connecting runs a real sync, so the answer is a product count rather
      // than a reassurance that something was saved.
      setMessage(
        result.synced
          ? `Connected. Imported ${result.imported} product(s).`
          : `Saved, but the first sync failed: ${result.message}`
      );
      setAccessToken("");
      setConsumerSecret("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect that store.");
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy("sync");
    setError(null);
    setMessage(null);
    try {
      const result = await authorisedFetch("/api/stores/sync", { method: "POST" });
      setMessage(
        `Synced ${result.imported} product(s)` +
          (result.deactivated ? `, switched off ${result.deactivated} no longer in your store` : "")
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The sync failed.");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setError(null);
    try {
      await authorisedFetch("/api/stores", { method: "DELETE" });
      setMessage("Disconnected. Your products stay in the catalog.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't disconnect.");
    } finally {
      setBusy(false);
    }
  };

  if (sessionLoading || bizLoading) return <LoadingState />;

  return (
    <div className="app">
      <div style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
        <h1 className="fs20 fw7" style={{ marginBottom: 4 }}>
          Connect your store
        </h1>
        <p className="mut fs12" style={{ marginBottom: 14 }}>
          Pull your products straight from Shopify or WooCommerce, so prices stay right and
          anything you delete stops being offered — no exporting, no uploading.
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
            <Link href="/login">Sign in</Link> to connect a store.
          </div>
        )}
        {session && !businessId && <NotConnectedNotice />}

        {session && businessId && (
          <>
            {status?.connected && (
              <div className="card" style={{ padding: 16, marginBottom: 12 }}>
                <div className="fx ac gap8 wrap" style={{ marginBottom: 10 }}>
                  <span className={status.lastStatus === "failed" ? "bdg err" : "bdg ok"}>
                    {status.provider === "shopify" ? "Shopify" : "WooCommerce"} connected
                  </span>
                  <span className="mut fs12 mono">{status.storeUrl}</span>
                </div>

                <p className="mut fs12" style={{ marginBottom: 10 }}>
                  Key {status.credential} · last sync {whenever(status.lastSyncedAt)}
                  {status.lastStatus === "ok" &&
                    ` · ${status.lastImported} product(s)` +
                      (status.lastDeactivated ? `, ${status.lastDeactivated} switched off` : "")}
                </p>

                {status.lastError && (
                  <p className="fs12" style={{ color: "var(--err)", marginBottom: 10 }}>
                    Last sync failed: {status.lastError}
                  </p>
                )}

                <div className="fx ac gap8 wrap">
                  <button className="btn-p" onClick={syncNow} disabled={Boolean(busy)}>
                    {busy === "sync" ? "Syncing…" : "Sync now"}
                  </button>
                  <button className="btn" onClick={disconnect} disabled={Boolean(busy)}>
                    {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
                  </button>
                </div>
              </div>
            )}

            <form className="card" style={{ padding: 16 }} onSubmit={connect}>
              <div className="flab" style={{ marginBottom: 8 }}>
                {status?.connected ? "Connect a different store" : "Which store do you use?"}
              </div>

              <div className="fx ac gap8" style={{ marginBottom: 14 }}>
                <button
                  type="button"
                  className={provider === "shopify" ? "btn-p" : "btn"}
                  onClick={() => setProvider("shopify")}
                >
                  Shopify
                </button>
                <button
                  type="button"
                  className={provider === "woocommerce" ? "btn-p" : "btn"}
                  onClick={() => setProvider("woocommerce")}
                >
                  WooCommerce
                </button>
              </div>

              {provider === "shopify" ? (
                <>
                  <ol className="mut fs12" style={{ paddingLeft: 18, marginBottom: 14 }}>
                    <li>In Shopify: <strong>Settings → Apps and sales channels → Develop apps</strong>.</li>
                    <li>Click <strong>Create an app</strong>, name it OmniChat, and create it.</li>
                    <li>
                      Open <strong>Configuration → Admin API integration → Configure</strong>, tick{" "}
                      <span className="mono">read_products</span>, and save.
                    </li>
                    <li>
                      Go to <strong>API credentials → Install app</strong>, then reveal and copy the{" "}
                      <strong>Admin API access token</strong>. It starts{" "}
                      <span className="mono">shpat_</span> and Shopify shows it once.
                    </li>
                  </ol>

                  <input
                    className="inp w100"
                    style={{ marginBottom: 10 }}
                    placeholder="yourshop.myshopify.com"
                    required
                    value={storeUrl}
                    onChange={(e) => setStoreUrl(e.target.value)}
                  />
                  <input
                    className="inp w100"
                    style={{ marginBottom: 10 }}
                    type="password"
                    placeholder="Admin API access token (shpat_…)"
                    required
                    value={accessToken}
                    onChange={(e) => setAccessToken(e.target.value)}
                  />
                </>
              ) : (
                <>
                  <ol className="mut fs12" style={{ paddingLeft: 18, marginBottom: 14 }}>
                    <li>
                      In WordPress: <strong>WooCommerce → Settings → Advanced → REST API</strong>.
                    </li>
                    <li>Click <strong>Add key</strong>, describe it as OmniChat.</li>
                    <li>
                      Set <strong>Permissions</strong> to <strong>Read</strong> — the agent never
                      needs to change your store.
                    </li>
                    <li>
                      Click <strong>Generate API key</strong> and copy both the consumer key and
                      the consumer secret before leaving the page.
                    </li>
                  </ol>

                  <input
                    className="inp w100"
                    style={{ marginBottom: 10 }}
                    placeholder="https://yourshop.com"
                    required
                    value={storeUrl}
                    onChange={(e) => setStoreUrl(e.target.value)}
                  />
                  <input
                    className="inp w100"
                    style={{ marginBottom: 10 }}
                    placeholder="Consumer key (ck_…)"
                    required
                    value={consumerKey}
                    onChange={(e) => setConsumerKey(e.target.value)}
                  />
                  <input
                    className="inp w100"
                    style={{ marginBottom: 10 }}
                    type="password"
                    placeholder="Consumer secret (cs_…)"
                    required
                    value={consumerSecret}
                    onChange={(e) => setConsumerSecret(e.target.value)}
                  />
                </>
              )}

              <button className="btn-p" type="submit" disabled={Boolean(busy)}>
                {busy === "connect" ? "Connecting…" : "Connect and import"}
              </button>

              <p className="mut fs12" style={{ marginTop: 10 }}>
                Connecting imports your products immediately, so you find out straight away whether
                the credentials work.
              </p>
            </form>

            {message && (
              <p className="mut fs12" style={{ marginTop: 10 }}>
                {message}
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

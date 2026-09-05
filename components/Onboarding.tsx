"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { ensureFreshSession, isExpiredSession } from "@/lib/supabase/session";
import type { Session } from "@supabase/supabase-js";

/**
 * The fallback, not the route.
 *
 * A shop is normally built during the first sign-in from what was typed at
 * signup, or claimed from an invite. This screen is what is left when neither
 * applied — an account made before the business name was asked for, or an
 * invite sent to a different address than the one they signed up with. Saying
 * which is the difference between a form and a dead end.
 */
export default function Onboarding({ session }: { session: Session }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Single RPC call (see supabase/schema.sql: create_business_and_agent) —
      // creates the business, the owner's agent row, and default agent_settings
      // in one atomic, SECURITY DEFINER transaction. Doing this as two separate
      // client-side inserts used to 403 on the businesses insert's RETURNING
      // clause, because the agents row (which current_business_id() depends on)
      // didn't exist yet at that point.
      const create = () =>
        supabase.rpc("create_business_and_agent", {
          business_name: businessName,
          agent_name: name,
        });

      let { error: rpcErr } = await create();

      // An access token lasts an hour, and this form is often the first thing
      // touched after a long gap. Refresh and try once rather than handing
      // back "JWT expired", which names a cause but no action.
      if (isExpiredSession(rpcErr)) {
        if (await ensureFreshSession()) {
          ({ error: rpcErr } = await create());
        } else {
          setSignedOut(true);
          throw new Error("Your sign-in expired. Sign in again and this will go through.");
        }
      }

      if (rpcErr) throw rpcErr;

      qc.invalidateQueries({ queryKey: ["current-business-id"] });
      qc.refetchQueries({ queryKey: ["current-business-id"] });
    } catch (err) {
      // PostgREST errors are plain objects, NOT `Error` instances, so
      // `err instanceof Error` alone would swallow the real message
      // ("fails silently"). Read `.message` defensively and surface it.
      const msg =
        (err as { message?: string })?.message ??
        (err instanceof Error ? err.message : null) ??
        "Something went wrong (see browser console for details).";
      setError(msg);
      console.error("Onboarding failed:", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ width: 400, padding: 28 }}>
        <h1 className="fs20 fw7" style={{ marginBottom: 4 }}>
          Set up your business
        </h1>
        <p className="mut fs12" style={{ marginBottom: 18 }}>
          You&apos;re signed in as <strong>{session.user.email}</strong>, but no shop is attached to
          it yet. Name it below and you&apos;re in.
        </p>

        <div className="notice fs12" style={{ marginBottom: 18 }}>
          Expecting to join a colleague&apos;s shop? Ask them to invite{" "}
          <strong>{session.user.email}</strong> from their Team page — an invite has to match the
          address you signed in with. Don&apos;t create a shop here, or you&apos;ll end up with an
          empty one of your own.
        </div>

        <form onSubmit={handleSubmit} className="col gap12">
          <div>
            <div className="flab" style={{ marginBottom: 6 }}>
              Your name
            </div>
            <input className="inp w100" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Maya Chen" />
          </div>
          <div>
            <div className="flab" style={{ marginBottom: 6 }}>
              Business name
            </div>
            <input
              className="inp w100"
              required
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="Maren Studio"
            />
          </div>

          {error && (
            <div className="mut fs12" style={{ color: "var(--err)" }}>
              {error}
            </div>
          )}

          {signedOut && (
            <button
              className="btn w100"
              type="button"
              onClick={async () => {
                await supabase.auth.signOut().catch(() => undefined);
                window.location.href = "/login";
              }}
            >
              Sign in again
            </button>
          )}

          <button className="btn-p w100" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create business"}
          </button>
        </form>
      </div>
    </div>
  );
}

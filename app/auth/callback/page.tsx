"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

/**
 * Where the email confirmation link lands.
 *
 * Supabase sends people back to the app with either a `code` to exchange (PKCE)
 * or tokens in the URL fragment (implicit), and reports failures as `error` and
 * `error_description` on the same URL. Without this page the link had nowhere
 * to go: the sign-in was never completed, and an expired or already-used link
 * showed the visitor nothing at all.
 *
 * Every branch here says what actually happened, in Supabase's own words — a
 * confirmation link that quietly does nothing is the least debuggable thing an
 * account can do.
 */
export default function AuthCallback() {
  const router = useRouter();
  const [status, setStatus] = useState<"working" | "ok" | "failed" | "setPassword">("working");
  const [problem, setProblem] = useState<string | null>(null);

  // "Email+link+is+invalid" — the query decoder leaves the pluses behind.
  const readable = (value: string | null) => value?.replace(/\+/g, " ") ?? null;

  useEffect(() => {
    let cancelled = false;

    // A password-reset link arrives here signed in, which is not the end of the
    // journey — the person came to change their password, and dropping them on
    // the dashboard leaves the old one in place.
    const isReset = new URL(window.location.href).searchParams.get("mode") === "reset";

    const finish = (nextStatus: "ok" | "failed", detail?: string) => {
      if (cancelled) return;
      if (nextStatus === "ok" && isReset) {
        setStatus("setPassword");
        return;
      }
      setStatus(nextStatus);
      if (detail) setProblem(detail);
      if (nextStatus === "ok") setTimeout(() => router.replace("/"), 1200);
    };

    (async () => {
      const here = new URL(window.location.href);
      const fragment = new URLSearchParams(here.hash.replace(/^#/, ""));
      const param = (name: string) =>
        readable(here.searchParams.get(name) ?? fragment.get(name));

      // Supabase reports refusals on the redirect itself, not as a failed call.
      const described = param("error_description") ?? param("error");
      if (described) return finish("failed", described);

      const code = here.searchParams.get("code");
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        return finish(error ? "failed" : "ok", error?.message);
      }

      // Implicit flow: the client consumes the fragment on load, so the only
      // question left is whether a session actually came out of it.
      const { data } = await supabase.auth.getSession();
      if (data?.session) return finish("ok");

      finish(
        "failed",
        "This link didn't carry a sign-in. It was most likely already used, or it expired."
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ width: 400, padding: 28 }}>
        <h1 className="fs20 fw7" style={{ marginBottom: 6 }}>
          {status === "working" && "Confirming your email…"}
          {status === "ok" && "You're confirmed"}
          {status === "setPassword" && "Choose a new password"}
          {status === "failed" && "That link didn't work"}
        </h1>

        {status === "working" && (
          <p className="mut fs12">One moment — finishing your sign-in.</p>
        )}

        {status === "ok" && <p className="mut fs12">Taking you to your dashboard…</p>}

        {status === "setPassword" && <SetNewPassword />}

        {status === "failed" && (
          <>
            <p className="mut fs12" style={{ marginBottom: 14 }}>
              Supabase said: <strong>{problem}</strong>
            </p>
            <ResendLink />
            <p className="mut fs12" style={{ marginTop: 16 }}>
              Already confirmed? <Link href="/login">Sign in</Link>.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Set a new password, using the session the recovery link just established.
 *
 * The link is the proof of identity — Supabase has already verified the
 * mailbox by the time this renders — so all that is left is the new password.
 */
function SetNewPassword() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 6) {
      setProblem("Use at least six characters.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setDone(true);
      setTimeout(() => router.replace("/"), 1200);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Couldn't set that password.");
    } finally {
      setBusy(false);
    }
  };

  if (done) return <p className="mut fs12">Password changed. Taking you to your dashboard…</p>;

  return (
    <form onSubmit={save} className="col gap12">
      <p className="mut fs12" style={{ margin: 0 }}>
        You&rsquo;re signed in from the link. Pick a password and you&rsquo;re done.
      </p>
      <input
        className="inp w100"
        type="password"
        required
        autoFocus
        minLength={6}
        placeholder="New password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="btn-p w100" type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save password"}
      </button>
      {problem && (
        <p className="fs12" style={{ color: "var(--err)", margin: 0 }}>
          {problem}
        </p>
      )}
    </form>
  );
}

/**
 * Confirmation links expire, and by far the most common reason one fails is
 * that it was opened too late. Sending a fresh one is the fix, so offer it
 * here rather than leaving someone stranded on a dead end.
 */
function ResendLink() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const resend = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setOutcome(null);
      try {
        const { error } = await supabase.auth.resend({
          type: "signup",
          email,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        setOutcome(error ? error.message : "Sent. Check your inbox for a fresh link.");
      } catch (err) {
        setOutcome(err instanceof Error ? err.message : "Couldn't send a new link.");
      } finally {
        setBusy(false);
      }
    },
    [email]
  );

  return (
    <form onSubmit={resend} className="col gap12">
      <div>
        <div className="flab" style={{ marginBottom: 6 }}>
          Send a new confirmation link
        </div>
        <input
          className="inp w100"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@business.com"
        />
      </div>
      <button className="btn" type="submit" disabled={busy || !email}>
        {busy ? "Sending…" : "Email me a new link"}
      </button>
      {outcome && <p className="mut fs12">{outcome}</p>}
    </form>
  );
}

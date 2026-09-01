"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase, isSupabaseConfigured } from "@/lib/supabase/client";
import { useSession } from "@/hooks/useSession";

export default function LoginPage() {
  const router = useRouter();
  const { session, loading } = useSession();

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && session) router.replace("/");
  }, [loading, session, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace("/");
      } else {
        // Without emailRedirectTo the confirmation link goes to whatever Site
        // URL Supabase has configured — by default http://localhost:3000, which
        // is a dead link for everyone who is not the developer. Sending people
        // back to the origin they actually signed up on is always right.
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        if (error) throw error;
        setNotice(
          "Account created. If email confirmation is on, open the link in your inbox — it will bring you back here signed in. Otherwise you're signed in already."
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ width: 360, padding: 28 }}>
        <div className="logo" style={{ padding: 0, marginBottom: 18 }}>
          <div className="mark">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
              <path d="M12 3v18" />
              <path d="M3 12h18" />
              <path d="M5.6 5.6l12.8 12.8" />
              <path d="M18.4 5.6 5.6 18.4" />
            </svg>
          </div>
          <span>
            OmniChat <span className="mut">AI</span>
          </span>
        </div>

        <h1 className="fs20 fw7" style={{ marginBottom: 4 }}>
          {mode === "signin" ? "Sign in" : "Create an account"}
        </h1>
        <p className="mut fs12" style={{ marginBottom: 18 }}>
          {mode === "signin" ? "Welcome back to your dashboard." : "Set up your OmniChat account."}
        </p>

        {!isSupabaseConfigured && (
          <div className="notice" style={{ marginBottom: 14 }}>
            Supabase isn&apos;t configured yet — fill in <span className="mono">.env.local</span> first (see the
            README).
          </div>
        )}

        <form onSubmit={handleSubmit} className="col gap12">
          <div>
            <div className="flab" style={{ marginBottom: 6 }}>
              Email
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
          <div>
            <div className="flab" style={{ marginBottom: 6 }}>
              Password
            </div>
            <input
              className="inp w100"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {error && <div className="mut fs12" style={{ color: "var(--err)" }}>{error}</div>}
          {notice && <div className="mut fs12" style={{ color: "var(--ok)" }}>{notice}</div>}

          <button className="btn-p w100" type="submit" disabled={busy}>
            {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Sign up"}
          </button>
        </form>

        <div className="fx jc mt16">
          <button
            className="btn sm"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
              setNotice(null);
            }}
          >
            {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}

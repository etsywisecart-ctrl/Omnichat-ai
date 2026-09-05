"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useBusinessGate } from "@/hooks/useCurrentBusinessId";
import { freshAccessToken } from "@/lib/supabase/session";
import { LoadingState, NotConnectedNotice } from "@/components/State";

/**
 * Everyone who can answer this shop's customers.
 *
 * Two people on one shop was previously a database edit. That is fine for the
 * person who wrote the database and impossible for the person who bought the
 * product.
 */

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  pending: boolean;
  isYou: boolean;
}

async function call(path: string, init: RequestInit = {}) {
  const token = await freshAccessToken();
  const response = await fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "That didn't work.");
  return payload;
}

export default function TeamPage() {
  const { session, businessId, loading, missing } = useBusinessGate();

  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await call("/api/team");
      setMembers(payload.members as Member[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load your team.");
    }
  }, []);

  useEffect(() => {
    if (businessId) void load();
  }, [businessId, load]);

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload = await call("/api/team", {
        method: "POST",
        body: JSON.stringify({ email, name }),
      });
      setNotice(payload.message as string);
      setEmail("");
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send that invite.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (member: Member) => {
    setError(null);
    setNotice(null);
    try {
      await call(`/api/team?id=${encodeURIComponent(member.id)}`, { method: "DELETE" });
      setNotice(`Removed ${member.email}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove them.");
    }
  };

  if (loading) return <LoadingState />;

  return (
    <div className="app">
      <div style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
        <h1 className="fs20 fw7" style={{ marginBottom: 4 }}>
          Your team
        </h1>
        <p className="mut fs12" style={{ marginBottom: 14 }}>
          Anyone here can read this shop&rsquo;s conversations and take over from the agent. Invite
          someone by email — they join this shop the first time they sign in, whether or not they
          already had an account.
        </p>

        <div className="fx ac gap8 wrap" style={{ marginBottom: 12 }}>
          <Link href="/" className="btn">
            Back to dashboard
          </Link>
        </div>

        {!session && (
          <div className="notice">
            <Link href="/login">Sign in</Link> to manage your team.
          </div>
        )}
        {missing && <NotConnectedNotice />}

        {session && businessId && (
          <>
            <div className="card" style={{ padding: 16, marginBottom: 12 }}>
              {members.length === 0 ? (
                <p className="mut fs12" style={{ margin: 0 }}>
                  Nobody listed yet.
                </p>
              ) : (
                members.map((member) => (
                  <div
                    key={member.id}
                    className="fx ac gap8 wrap"
                    style={{ padding: "8px 0", borderBottom: "1px solid var(--bd)" }}
                  >
                    <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                      <div className="fw6 fs13">
                        {member.name} {member.isYou && <span className="mut fs11">(you)</span>}
                      </div>
                      <div className="mut fs11 mono">{member.email}</div>
                    </div>
                    <span className="ftag">{member.role}</span>
                    {member.pending && <span className="bdg warn">Invited</span>}
                    {!member.isYou && (
                      <button
                        className="btn"
                        style={{ padding: "2px 8px", fontSize: 12 }}
                        onClick={() => remove(member)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            <form className="card" style={{ padding: 16 }} onSubmit={invite}>
              <div className="flab" style={{ marginBottom: 8 }}>
                Invite someone
              </div>
              <div className="fx ac gap8 wrap" style={{ marginBottom: 10 }}>
                <input
                  className="inp"
                  style={{ flex: "2 1 220px" }}
                  type="email"
                  required
                  placeholder="their@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <input
                  className="inp"
                  style={{ flex: "1 1 150px" }}
                  placeholder="Their name (optional)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <button className="btn-p" type="submit" disabled={busy}>
                {busy ? "Inviting…" : "Send invite"}
              </button>
            </form>

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

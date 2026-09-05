import { NextRequest, NextResponse } from "next/server";
import { resolveBusiness, UNAUTHORIZED } from "@/lib/supabase/auth";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who can see and answer this shop's conversations.
 *
 * An invite is an agents row carrying an email with no user_id yet, claimed
 * the first time that person signs in. That ordering matters: a shop owner
 * should be able to invite a colleague who has never heard of this app, and
 * the two accounts should end up on one shop without anyone running SQL —
 * which until now was the only way, and it is not a feature, it is a favour.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AgentRow {
  id: string;
  name: string;
  email: string;
  role: string;
  user_id: string | null;
  created_at: string;
}

export async function GET(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from("agents")
    .select("id, name, email, role, user_id, created_at")
    .eq("business_id", ctx.businessId)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ message: error.message }, { status: 500 });

  return NextResponse.json({
    members: ((data ?? []) as AgentRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      // Pending until the invited person has signed in at least once.
      pending: row.user_id === null,
      isYou: row.user_id === ctx.userId,
    })),
  });
}

export async function POST(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "Send JSON." }, { status: 400 });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim() || email.split("@")[0];
  const role = body.role === "owner" ? "owner" : "agent";

  if (!EMAIL.test(email)) {
    return NextResponse.json({ message: "That doesn't look like an email address." }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("agents")
    .insert({ business_id: ctx.businessId, user_id: null, name, email, role });

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ message: `${email} is already on this shop.` }, { status: 409 });
    }
    const missing = /uq_agents_business_email|column .*email/i.test(error.message);
    return NextResponse.json(
      {
        message: missing
          ? "Run supabase/migrations/003_team_and_limits.sql in Supabase → SQL Editor first."
          : error.message,
      },
      { status: missing ? 503 : 500 }
    );
  }

  // Best effort: the invite works whether or not the email arrives, because
  // the row is claimed on first sign-in either way. A failed send must not
  // leave a half-made membership behind.
  let emailed = false;
  try {
    const origin = request.nextUrl.origin;
    const admin = supabaseAdmin.auth.admin as {
      inviteUserByEmail?: (address: string, options?: unknown) => Promise<{ error: unknown }>;
    };
    if (typeof admin.inviteUserByEmail === "function") {
      const { error: inviteError } = await admin.inviteUserByEmail(email, {
        redirectTo: `${origin}/auth/callback`,
      });
      emailed = !inviteError;
    }
  } catch (inviteError) {
    console.warn("team invite email failed (the membership still stands):", inviteError);
  }

  return NextResponse.json({
    invited: email,
    emailed,
    message: emailed
      ? `Invited ${email}. They'll get an email; signing in joins them to this shop.`
      : `Added ${email}. No email went out — tell them to sign up with this exact address and they'll join automatically.`,
  });
}

export async function DELETE(request: NextRequest) {
  const ctx = await resolveBusiness(request);
  if (!ctx) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ message: "Which member?" }, { status: 400 });

  const { data: target } = await supabaseAdmin
    .from("agents")
    .select("id, user_id")
    .eq("id", id)
    .eq("business_id", ctx.businessId)
    .maybeSingle();

  if (!target) return NextResponse.json({ message: "No such member." }, { status: 404 });

  // Removing yourself locks you out of your own shop with no way back in.
  if ((target as { user_id: string | null }).user_id === ctx.userId) {
    return NextResponse.json(
      { message: "You can't remove yourself. Ask another owner to do it." },
      { status: 400 }
    );
  }

  const { count } = await supabaseAdmin
    .from("agents")
    .select("id", { count: "exact", head: true })
    .eq("business_id", ctx.businessId);

  if ((count ?? 0) <= 1) {
    return NextResponse.json({ message: "A shop needs at least one member." }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from("agents").delete().eq("id", id);
  if (error) return NextResponse.json({ message: error.message }, { status: 500 });

  return NextResponse.json({ removed: id });
}

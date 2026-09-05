"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { ensureFreshSession } from "@/lib/supabase/session";

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    // Refresh on load instead of trusting what is stored. A tab reopened the
    // next morning holds a session whose access token expired hours ago; taking
    // it at face value means every query fails and the app blames the data.
    ensureFreshSession().then((fresh) => {
      if (!mounted) return;
      setSession(fresh);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event: string, sessionState: Session | null) => {
      setSession(sessionState);
      setLoading(false);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, loading };
}

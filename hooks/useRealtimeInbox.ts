"use client";

import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase/client";
import { useDashboardStore } from "@/store/useDashboardStore";

/** Coalesce bursts — a webhook writes the message and the conversation together. */
const REFRESH_DEBOUNCE_MS = 400;

/**
 * Keep the Inbox live.
 *
 * Subscribes to inserts and updates on this business's conversations and
 * messages and refreshes the affected view. Row-level security applies to
 * realtime just as it does to queries, so a subscriber is only ever sent rows
 * their own policies would let them read — one business never sees another's
 * traffic, even though both share the channel name space.
 *
 * Requires the tables to be in the supabase_realtime publication; see
 * section 11 of supabase/schema.sql. Without that the subscription connects
 * happily and simply never fires.
 */
export function useRealtimeInbox(businessId: string | null | undefined) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!businessId) return;

    const scheduleRefresh = (conversationId?: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const state = useDashboardStore.getState();
        void state.fetchConversations(state.searchQuery);
        void state.fetchStats();
        // Only reload the thread the agent is actually looking at.
        const open = state.sel;
        if (open && (!conversationId || conversationId === open)) {
          void state.fetchConversationThread(open);
        }
      }, REFRESH_DEBOUNCE_MS);
    };

    const channel = supabase
      .channel(`inbox:${businessId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `business_id=eq.${businessId}`,
        },
        (payload: { new?: { conversation_id?: string } }) =>
          scheduleRefresh(payload.new?.conversation_id)
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `business_id=eq.${businessId}`,
        },
        () => scheduleRefresh()
      )
      .subscribe();

    return () => {
      if (timer.current) clearTimeout(timer.current);
      void supabase.removeChannel(channel);
    };
  }, [businessId]);
}

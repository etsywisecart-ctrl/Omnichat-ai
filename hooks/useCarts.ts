import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";
import { useCurrentBusinessId } from "./useCurrentBusinessId";

export function useCarts() {
  const { data: businessId } = useCurrentBusinessId();
  return useQuery({
    queryKey: ["carts", businessId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("carts")
        .select("*")
        .eq("business_id", businessId as string)
        .order("last_activity_at", { ascending: false });
      if (error) throw error;
      return data as Database["public"]["Tables"]["carts"]["Row"][];
    },
    enabled: Boolean(businessId),
  });
}

/**
 * Send an abandoned-cart reminder.
 *
 * This used to write a note to the cart row and call it done — no message was
 * ever sent. It now goes through the API, which sends on the real channel and
 * only records the note once the channel has accepted it.
 */
export function useSendCartReminder() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, text }: { id: string; text?: string }) => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("You're signed out — sign in again to send.");

      const res = await fetch(`/api/carts/${id}/remind`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(text ? { text } : {}),
      });

      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.message ?? `Couldn't send the reminder (HTTP ${res.status})`);
      }
      return payload;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["carts"] });
    },
  });
}

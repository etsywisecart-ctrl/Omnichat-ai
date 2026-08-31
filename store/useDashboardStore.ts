import { create } from "zustand";
import type { PageId, SettingsTab, ThemeOverride } from "@/lib/types";
import { supabase } from "@/lib/supabase/client";

export type ConvFilter = "all" | "bot_active" | "handed_off" | "closed";
export type OrderFilter = "all" | "draft" | "pending_payment" | "paid" | "fulfilled" | "cancelled";

// ---- Backend data types ----

export interface DashboardStats {
  open: number;
  waiting_for_human: number;
  pending_payment: number;
  pending_payment_total_cents: number;
  pending_orders: Array<{
    id: string;
    display_id: string | null;
    customer_name: string | null;
    total_cents: number | null;
    currency: string;
  }>;
  carts_at_risk: number;
  needs_attention: number;
  agent_activity: {
    open: number;
    waiting: number;
    resolved: number;
    total: number;
  };
  orders: {
    total: number;
    pending: number;
    paid: number;
    abandoned: number;
  };
  total_conversations: number;
}

export interface ConversationData {
  id: string;
  business_id: string;
  customer_name: string;
  customer_identifier: string | null;
  channel_type: "whatsapp" | "instagram" | "messenger" | "web";
  status: string; // 'bot_active' | 'handed_off' | 'closed' | 'open'
  last_message_preview: string | null;
  last_message_at: string;
  created_at: string;
  updated_at?: string | null;
}

// A message inside a conversation thread (from backend /api/dashboard/conversation/:id).
export interface MessageData {
  id: string;
  conversation_id: string;
  sender_type: "customer" | "agent" | "bot" | "system";
  direction: "incoming" | "outgoing";
  body: string;
  created_at: string;
}

export type ConvUiStatus = "bot_active" | "handed_off" | "closed";

// The schema stores the UI statuses directly. This only normalises the legacy
// 'open' value (and anything unexpected) to the bot-handled state.
export function mapConvStatus(status: string): ConvUiStatus {
  if (status === "handed_off") return "handed_off";
  if (status === "closed") return "closed";
  return "bot_active";
}

interface UIState {
  // --- Page / UI state (unchanged) ---
  page: PageId;
  themeOverride: ThemeOverride;
  sysDark: boolean;

  sel: string | null;
  convFilter: ConvFilter;
  draft: string;

  q: string;
  ordFilter: OrderFilter;
  expOrd: string | null;

  toast: string | null;

  widgetOpen: boolean;
  stab: SettingsTab;

  setPage: (p: PageId) => void;
  toggleTheme: () => void;
  setSysDark: (v: boolean) => void;

  selectConv: (id: string) => void;
  setConvFilter: (f: ConvFilter) => void;
  setDraft: (v: string) => void;

  setQuery: (v: string) => void;
  setOrderFilter: (f: OrderFilter) => void;
  toggleExpandOrder: (id: string) => void;

  toggleWidget: () => void;
  setSettingsTab: (t: SettingsTab) => void;
  say: (msg: string) => void;

  // --- Dashboard data (fetched from backend API on port 5000) ---
  stats: DashboardStats | null;
  conversations: ConversationData[];
  messages: MessageData[];
  dashboardLoading: boolean;
  dashboardError: string | null;
  searchQuery: string;

  sending: boolean;
  sendError: string | null;

  fetchStats: () => Promise<void>;
  fetchConversations: (search?: string) => Promise<void>;
  fetchConversationThread: (id: string) => Promise<void>;
  refreshDashboard: () => Promise<void>;
  setSearchQuery: (q: string) => void;
  sendReply: (conversationId: string, text: string) => Promise<boolean>;
  setConversationStatus: (conversationId: string, status: ConvUiStatus) => Promise<void>;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Fetch a dashboard endpoint with the signed-in user's access token attached.
 * The API resolves the business from that token, so the browser never gets to
 * name which business it wants to read.
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not signed in");
  return fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

export const useDashboardStore = create<UIState>((set, get) => ({
  // --- Page / UI state (unchanged) ---
  page: "overview",
  themeOverride: null,
  sysDark: false,

  sel: null,
  convFilter: "all",
  draft: "",

  q: "",
  ordFilter: "all",
  expOrd: null,

  toast: null,

  widgetOpen: true,
  stab: "agent",

  say: (msg) => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: msg });
    toastTimer = setTimeout(() => set({ toast: null }), 3000);
  },

  setPage: (p) => set({ page: p }),
  toggleTheme: () =>
    set((s) => {
      const dark = s.themeOverride ? s.themeOverride === "dark" : s.sysDark;
      return { themeOverride: dark ? "light" : "dark" };
    }),
  setSysDark: (v) => set({ sysDark: v }),

  selectConv: (id) => set({ sel: id, draft: "" }),
  setConvFilter: (f) => set({ convFilter: f }),
  setDraft: (v) => set({ draft: v }),

  setQuery: (v) => set({ q: v }),
  setOrderFilter: (f) => set({ ordFilter: f }),
  toggleExpandOrder: (id) => set((s) => ({ expOrd: s.expOrd === id ? null : id })),

  toggleWidget: () => set((s) => ({ widgetOpen: !s.widgetOpen })),
  setSettingsTab: (t) => set({ stab: t }),

  // --- Dashboard data ---
  stats: null,
  conversations: [],
  messages: [],
  dashboardLoading: false,
  dashboardError: null,
  searchQuery: "",
  sending: false,
  sendError: null,

  fetchStats: async () => {
    set({ dashboardLoading: true, dashboardError: null });
    try {
      const res = await authedFetch("/api/dashboard/stats");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DashboardStats;
      set({ stats: data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load stats";
      console.error("[dashboard] fetchStats error:", msg);
      set({ dashboardError: msg });
    } finally {
      set({ dashboardLoading: false });
    }
  },

  fetchConversations: async (search?: string) => {
    try {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (search) params.set("search", search);

      const res = await authedFetch(`/api/dashboard/conversations?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { conversations: ConversationData[]; total: number };
      set({ conversations: data.conversations ?? [] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load conversations";
      console.error("[dashboard] fetchConversations error:", msg);
      set({ dashboardError: msg });
    }
  },

  refreshDashboard: async () => {
    set({ dashboardLoading: true, dashboardError: null });
    try {
      await Promise.all([
        get().fetchStats(),
        get().fetchConversations(get().searchQuery),
      ]);
    } finally {
      set({ dashboardLoading: false });
    }
  },

  fetchConversationThread: async (id: string) => {
    try {
      const res = await authedFetch(`/api/dashboard/conversation/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        conversation: ConversationData;
        messages: MessageData[];
      };
      set({ messages: data.messages ?? [] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load messages";
      console.error("[dashboard] fetchConversationThread error:", msg);
      set({ dashboardError: msg });
    }
  },

  /**
   * Send an agent reply. Returns true on success so the composer only clears
   * the draft when the message actually went out.
   */
  sendReply: async (conversationId, text) => {
    const body = text.trim();
    if (!body) return false;

    set({ sending: true, sendError: null });
    try {
      const res = await authedFetch(`/api/dashboard/conversation/${conversationId}/reply`, {
        method: "POST",
        body: JSON.stringify({ text: body }),
      });

      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.message ?? `Couldn't send (HTTP ${res.status})`);
      }

      await get().fetchConversationThread(conversationId);
      await get().fetchConversations(get().searchQuery);
      set({ draft: "" });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't send that message";
      console.error("[dashboard] sendReply error:", msg);
      set({ sendError: msg });
      return false;
    } finally {
      set({ sending: false });
    }
  },

  setConversationStatus: async (conversationId, status) => {
    try {
      const res = await authedFetch(`/api/dashboard/conversation/${conversationId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await get().fetchConversations(get().searchQuery);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't update the conversation";
      console.error("[dashboard] setConversationStatus error:", msg);
      set({ sendError: msg });
    }
  },

  setSearchQuery: (q) => {
    set({ searchQuery: q });
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      get().fetchConversations(q);
    }, 300);
  },
}));

export const isDark = (s: Pick<UIState, "themeOverride" | "sysDark">) =>
  s.themeOverride ? s.themeOverride === "dark" : s.sysDark;

"use client";

import { useEffect, useState } from "react";
import { useDashboardStore, mapConvStatus } from "@/store/useDashboardStore";
import type { ConversationData, MessageData } from "@/store/useDashboardStore";
import { CONV_BADGE, CHANNELS, mapChannelType } from "@/lib/data";
import { EmptyState, LoadingState } from "@/components/State";

// Conversations carry their own channel, so the Inbox reads the real channel
// for each thread instead of assuming WhatsApp.

const FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "bot_active", label: "Bot" },
  { id: "handed_off", label: "Needs human" },
  { id: "closed", label: "Closed" },
];

// Get the UI-mapped status (open -> bot_active, needs_human -> handed_off, closed -> closed).
function getUiStatus(c: ConversationData) {
  return mapConvStatus(c.status);
}

export default function Inbox() {
  // ---- Data from the backend store ----
  const conversations = useDashboardStore((s) => s.conversations);
  const messages = useDashboardStore((s) => s.messages);
  const dashboardLoading = useDashboardStore((s) => s.dashboardLoading);
  const fetchConversations = useDashboardStore((s) => s.fetchConversations);
  const fetchConversationThread = useDashboardStore((s) => s.fetchConversationThread);

  // ---- UI selection state ----
  const sel = useDashboardStore((s) => s.sel);
  const convFilter = useDashboardStore((s) => s.convFilter);
  const setConvFilter = useDashboardStore((s) => s.setConvFilter);
  const selectConv = useDashboardStore((s) => s.selectConv);

  // ---- Composer ----
  const draft = useDashboardStore((s) => s.draft);
  const setDraft = useDashboardStore((s) => s.setDraft);
  const sending = useDashboardStore((s) => s.sending);
  const sendError = useDashboardStore((s) => s.sendError);
  const sendReply = useDashboardStore((s) => s.sendReply);
  const setConversationStatus = useDashboardStore((s) => s.setConversationStatus);

  // ---- Debounced Inbox search (client-side) ----
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch conversations on mount.
  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const list = conversations;

  // Selected conversation (default to the first one).
  const sc: ConversationData | null =
    (sel ? list.find((c) => c.id === sel) ?? list[0] : list[0]) ?? null;

  // Load the thread for the selected conversation whenever it changes.
  useEffect(() => {
    if (sc?.id) fetchConversationThread(sc.id);
  }, [sc?.id, fetchConversationThread]);

  if (dashboardLoading && list.length === 0) {
    return (
      <div className="ipage" data-screen-label="Inbox">
        <LoadingState rows={5} />
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="ipage" data-screen-label="Inbox" style={{ display: "block" }}>
        <EmptyState
          icon="💬"
          title="No conversations yet"
          desc="Send a WhatsApp message to test. Conversations will show up here as customers message in."
        />
      </div>
    );
  }

  // Client-side filter by status (mapped) AND debounced search text.
  const q = debouncedSearch.trim().toLowerCase();
  const shown = list.filter((c) => {
    const ui = mapConvStatus(c.status);
    const matchesFilter = convFilter === "all" || ui === convFilter;
    const matchesSearch =
      !q ||
      (c.customer_name || "").toLowerCase().includes(q) ||
      (c.customer_identifier || "").toLowerCase().includes(q) ||
      (c.last_message_preview || "").toLowerCase().includes(q);
    return matchesFilter && matchesSearch;
  });

  // Per-filter counts (based on the full fetched list, not the search).
  const countFor = (id: string) =>
    id === "all"
      ? list.length
      : list.filter((c) => mapConvStatus(c.status) === id).length;
return (
    <div className="ipage" data-screen-label="Inbox">
      {/* ---- Left: conversation list ---- */}
      <div className="clist">
        <div className="clhead">
          <span className="fw6 fs15">Inbox</span>
          <span className="mut fs12">{list.length} conversations</span>
        </div>

        <div style={{ padding: "0 14px 8px" }}>
          <input
            className="inp"
            placeholder="Search conversations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="fx gap8 wrap" style={{ padding: "0 14px 10px" }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={"chip" + (convFilter === f.id ? " on" : "")}
              onClick={() => setConvFilter(f.id as never)}
            >
              {f.label} {countFor(f.id)}
            </button>
          ))}
        </div>

        <div className="f1" style={{ overflow: "auto", padding: "4px 8px 12px" }}>
          {shown.length === 0 ? (
            <EmptyState title="No matches" desc="No conversations match that search or filter." />
          ) : (
            shown.map((c) => {
              const ui = mapConvStatus(c.status);
              const ch = CHANNELS[mapChannelType(c.channel_type)] ?? CHANNELS.web;
              return (
                <button
                  key={c.id}
                  className={"convi" + (c.id === sc?.id ? " on" : "")}
                  onClick={() => selectConv(c.id)}
                >
                  <div className={ch.cls}>{ch.ab}</div>
                  <div className="f1" style={{ minWidth: 0 }}>
                    <div className="fx ac jb gap8">
                      <span className="fw6 fs13 ell">{c.customer_name || c.customer_identifier}</span>
                      <span className="mut fs11 noshrink">
                        {c.last_message_at
                          ? new Date(c.last_message_at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : ""}
                      </span>
                    </div>
                    <div className="mut fs12 ell mt2">{c.last_message_preview || "—"}</div>
                  </div>
                  {ui === "handed_off" && <div className="adot warn noshrink" />}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ---- Right: thread + customer ---- */}
      {sc && (
        <>
          <div className="thr">
            <div className="thead2">
              <div style={{ minWidth: 0 }}>
                <div className="fx ac gap8">
                  <span className="fw6 fs14">{sc.customer_name || sc.customer_identifier}</span>
                  <span className={CONV_BADGE[getUiStatus(sc)].cls}>
                    {CONV_BADGE[getUiStatus(sc)].label}
                  </span>
                  <span className="chip" style={{ padding: "4px 8px", borderRadius: "4px" }}>
                    {(CHANNELS[mapChannelType(sc.channel_type)] ?? CHANNELS.web).label}
                  </span>
                </div>
                <div className="mut fs12 mt2 ell">{sc.customer_identifier || "—"}</div>
              </div>
            </div>

            <div className="mlist">
              {renderMessages(messages)}
            </div>

            <form
              className="composer"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!sc?.id) return;
                await sendReply(sc.id, draft);
              }}
            >
              {sendError && (
                <div className="mut fs12" style={{ color: "var(--err)", marginBottom: 8 }}>
                  {sendError}
                </div>
              )}
              <div className="fx gap8 ac">
                <input
                  className="inp f1"
                  placeholder={`Reply to ${sc.customer_name || "this customer"}…`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={sending}
                  aria-label="Your reply"
                />
                <button className="btn-p" type="submit" disabled={sending || !draft.trim()}>
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
              <div className="fx gap8 ac mt8">
                <span className="mut fs11">Replying takes this conversation off the bot.</span>
                <div className="f1" />
                {getUiStatus(sc) !== "bot_active" && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => setConversationStatus(sc.id, "bot_active")}
                  >
                    Give back to bot
                  </button>
                )}
                {getUiStatus(sc) !== "closed" && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => setConversationStatus(sc.id, "closed")}
                  >
                    Mark resolved
                  </button>
                )}
              </div>
            </form>
          </div>

          <div className="ctx">
            <div className="slab">Customer</div>
            <div className="card" style={{ padding: 14 }}>
              <div className="fw6 fs13">{sc.customer_name || "—"}</div>
              <div className="mut fs12 mt2">{sc.customer_identifier || "—"}</div>
              <div className="frow2">
                <span className="mut fs12">Channel</span>
                <span className="fs12 fw6">
                  {(CHANNELS[mapChannelType(sc.channel_type)] ?? CHANNELS.web).label}
                </span>
              </div>
              <div className="frow2">
                <span className="mut fs12">Status</span>
                <span className="fs12 fw6">{CONV_BADGE[getUiStatus(sc)].label}</span>
              </div>
              <div className="frow2">
                <span className="mut fs12">Last message</span>
                <span className="fs12 ell" style={{ maxWidth: 140 }}>
                  {sc.last_message_preview || "—"}
                </span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const SENDER_LABEL: Record<string, string> = {
  customer: "Customer",
  agent: "Agent",
  bot: "AI agent",
  system: "System",
};

// Render the message thread. Incoming sits left, outgoing sits right.
function renderMessages(msgs: MessageData[]) {
  if (!msgs || msgs.length === 0) {
    return <EmptyState title="No messages yet" desc="This conversation has no messages." />;
  }
  return msgs.map((m) => {
    const isIncoming = m.direction === "incoming";
    return (
      <div className={"mrow " + (isIncoming ? "l" : "r")} key={m.id}>
        <div className={"msg " + (isIncoming ? "cust" : "agent")}>{m.body}</div>
        <div className="mmeta">
          {SENDER_LABEL[m.sender_type] ?? m.sender_type} ·{" "}
          {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
    );
  });
}
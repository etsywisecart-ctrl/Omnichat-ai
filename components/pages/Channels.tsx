"use client";

import { useDashboardStore } from "@/store/useDashboardStore";
import { useChannels } from "@/hooks/useChannels";
import { useAgentSettings } from "@/hooks/useSettings";
import { useCurrentBusinessId } from "@/hooks/useCurrentBusinessId";
import { LoadingState, NotConnectedNotice } from "@/components/State";

const CHANNEL_META: Record<string, { label: string; sub: string; ab: string; cls: string }> = {
  wa: { label: "WhatsApp", sub: "Meta WhatsApp Cloud API", ab: "WA", cls: "ch lg wa" },
  ig: { label: "Instagram", sub: "Instagram Messaging API", ab: "IG", cls: "ch lg ig" },
  ms: { label: "Messenger", sub: "Messenger Platform API", ab: "MS", cls: "ch lg ms" },
  web: { label: "Website widget", sub: "One JS snippet · no-code install", ab: "</>", cls: "ch lg web" },
};

const STATUS_BADGE: Record<string, string> = {
  connected: "bdg ok",
  live: "bdg ok",
  not_connected: "bdg mut2",
};

export default function Channels() {
  const { data: businessId, isLoading: bizLoading } = useCurrentBusinessId();
  const { data: channels, isLoading } = useChannels();
  const { data: settings } = useAgentSettings();
  const widgetOpen = useDashboardStore((s) => s.widgetOpen);
  const toggleWidget = useDashboardStore((s) => s.toggleWidget);
  const say = useDashboardStore((s) => s.say);

  const notConnected = !bizLoading && !businessId;
  const byChannel: Record<string, { status: string; config: Record<string, unknown> }> = {};
  (channels || []).forEach((c) => {
    // Map channel_type from database to UI identifiers
    const channelKey = c.channel_type === "whatsapp" ? "wa" : c.channel_type === "instagram" ? "ig" : c.channel_type === "messenger" ? "ms" : "web";
    byChannel[channelKey] = { status: c.status, config: c.metadata || {} };
  });

  const greet = settings?.greeting_message || "Hi! How can I help you today?";

  const copySnippet = () => {
    const tag = '<script src="https://cdn.omnichat.ai/widget.js" data-business="biz_maren_7f2a" async></script>';
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(tag).catch(() => {});
    }
    say("Widget snippet copied");
  };

  return (
    <div className="pwrap">
      <div className="page" data-screen-label="Channels">
        <div className="phead">
          <div>
            <h1 className="h1">Channels</h1>
            <p className="sub">
              One AI brain, one catalog, many channels — connect once, the same agent replies everywhere.
            </p>
          </div>
        </div>

        {notConnected && <NotConnectedNotice />}

        {isLoading ? (
          <LoadingState rows={4} />
        ) : (
          <div className="chgrid">
            {(["wa", "web", "ms", "ig"] as const).map((chId) => {
              const meta = CHANNEL_META[chId];
              const conn = byChannel[chId];
              const status = conn?.status || "not_connected";
              const label = status === "not_connected" ? "Not connected" : status === "live" ? "Live" : "Connected";

              return (
                <div className="card" key={chId}>
                  <div className="chch">
                    <div className={meta.cls}>{meta.ab}</div>
                    <div className="f1">
                      <div className="fw6 fs14">{meta.label}</div>
                      <div className="mut fs12">{meta.sub}</div>
                    </div>
                    <span className={STATUS_BADGE[status]}>{label}</span>
                  </div>

                  {status === "not_connected" ? (
                    <div className="kvr" style={{ justifyContent: "flex-end" }}>
                      <button
                        className="btn sm"
                        onClick={() => {
                          // One place to connect a channel. The modal this
                          // replaced printed a webhook URL on a placeholder
                          // domain, at a path that is not the WhatsApp
                          // webhook — following it pointed Meta at nothing.
                          window.location.href = chId === "web" ? "/widget" : "/channels-setup";
                        }}
                      >
                        Connect {meta.label}
                      </button>
                    </div>
                  ) : chId === "web" ? (
                    <>
                      <div style={{ padding: "0 16px 12px" }}>
                        <div className="code">
                          {'<script src="https://cdn.omnichat.ai/widget.js"\n  data-business="biz_maren_7f2a" async></script>'}
                        </div>
                        <div className="fx ac jb" style={{ marginTop: 10, gap: 10 }}>
                          <span className="mut fs12">Same AI engine, catalog, and orders as every channel.</span>
                          <button className="btn sm" onClick={copySnippet}>
                            Copy snippet
                          </button>
                        </div>
                      </div>
                      <div className="wprev">
                        <div className="wline" style={{ width: "38%", marginTop: 18 }} />
                        <div className="wline" style={{ width: "70%" }} />
                        <div className="wline" style={{ width: "60%" }} />
                        <div className="wline" style={{ width: "66%", opacity: 0.5 }} />
                        <div className="wline" style={{ width: "30%", opacity: 0.5 }} />
                        {widgetOpen && (
                          <div className="wchat">
                            <div className="wchath">
                              <div className="mark" style={{ width: 24, height: 24, borderRadius: 7 }}>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
                                  <path d="M12 3v18" />
                                  <path d="M3 12h18" />
                                  <path d="M5.6 5.6l12.8 12.8" />
                                  <path d="M18.4 5.6 5.6 18.4" />
                                </svg>
                              </div>
                              <div>
                                <div className="fw6 fs12">Maren Studio</div>
                                <div className="mut fs11">AI agent · replies instantly</div>
                              </div>
                            </div>
                            <div className="wmsg">{greet}</div>
                            <div className="winp">Type a message…</div>
                          </div>
                        )}
                        <button className="wbub" onClick={toggleWidget}>
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                          </svg>
                        </button>
                      </div>
                    </>
                  ) : (
                    <div style={{ padding: "0 16px 16px" }}>
                      {Object.entries(conn.config).length === 0 ? (
                        <div className="mut fs12">Connected — no additional config stored.</div>
                      ) : (
                        Object.entries(conn.config).map(([k, v]) => (
                          <div className="kvr" key={k}>
                            <span className="mut">{k}</span>
                            <span className="mono">{String(v)}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

      </div>
    </div>
  );
}

"use client";

import { CHANNELS, CART_BADGE, mapChannelType } from "@/lib/data";
import { useCarts, useSendCartReminder } from "@/hooks/useCarts";
import { useAgentSettings, useSaveAgentSettings } from "@/hooks/useSettings";
import { useCurrentBusinessId } from "@/hooks/useCurrentBusinessId";
import { EmptyState, LoadingState, NotConnectedNotice } from "@/components/State";
import { useDashboardStore } from "@/store/useDashboardStore";

export default function Carts() {
  const { data: businessId, isLoading: bizLoading } = useCurrentBusinessId();
  const { data: carts, isLoading } = useCarts();
  const sendReminder = useSendCartReminder();
  const { data: settings } = useAgentSettings();
  const saveSettings = useSaveAgentSettings();
  const say = useDashboardStore((s) => s.say);

  const notConnected = !bizLoading && !businessId;
  const list = carts || [];
  const threshold = settings?.cart_abandon_threshold || "1 hour";

  return (
    <div className="pwrap">
      <div className="page" data-screen-label="Carts">
        <div className="phead">
          <div>
            <h1 className="h1">Carts &amp; recovery</h1>
            <p className="sub">
              Abandonment automation — one follow-up per cart, always inside channel messaging rules.
            </p>
          </div>
        </div>

        {notConnected && <NotConnectedNotice />}

        <div className="card">
          <div className="frow" style={{ borderTop: "none" }}>
            <div>
              <div className="flab">Abandonment threshold</div>
              <div className="fdesc">A cart becomes abandoned when last_activity_at is older than this.</div>
            </div>
            <div className="fx ac gap10">
              <span className="tbd">suggested default — confirm §16</span>
              <select
                className="inp"
                value={threshold}
                onChange={(e) => {
                  saveSettings.mutate({ cart_abandon_threshold: e.target.value });
                  say("Threshold updated — flagged as an open decision (§16)");
                }}
              >
                <option value="30 minutes">30 minutes</option>
                <option value="1 hour">1 hour</option>
                <option value="2 hours">2 hours</option>
              </select>
            </div>
          </div>
          <div className="frow">
            <div>
              <div className="flab">Reminder retries</div>
              <div className="fdesc">Exactly one follow-up per abandoned cart — repeated nudges read as spam.</div>
            </div>
            <div className="fx ac gap10">
              <span className="tbd">suggested default — confirm §16</span>
              <span className="fw6 fs13">1 reminder max</span>
            </div>
          </div>
          <div className="frow">
            <div>
              <div className="flab">Outside the 24h window</div>
              <div className="fdesc">
                WhatsApp requires a pre-approved template message once the customer&apos;s last message is over 24h
                old.
              </div>
            </div>
            <div className="fx ac gap8">
              <span className="mono fs12">cart_reminder</span>
              <span className="bdg ok">Approved</span>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="mt16"><LoadingState rows={3} /></div>
        ) : list.length === 0 ? (
          <div className="card mt16">
            <EmptyState
              icon="🛒"
              title="No carts yet"
              desc="Abandoned and active carts detected from chat will show up here, with a one-click recovery reminder."
            />
          </div>
        ) : (
          <div className="card mt16">
            <div className="trow crow hd">
              <span>Customer</span>
              <span>Items</span>
              <span>Value</span>
              <span>Last activity</span>
              <span>Status</span>
              <span>Reminder</span>
            </div>
            {list.map((c) => {
              const channelKey = mapChannelType(c.channel_type);
              const ch = CHANNELS[channelKey];
              const canSend = !c.reminder_sent_note && c.status === "abandoned";
              const sendLabel = c.within_session_window ? "Send reminder" : "Send template";
              return (
                <div className="trow crow" key={c.id}>
                  <div className="fx ac gap8" style={{ minWidth: 0 }}>
                    <div className={ch.cls}>{ch.ab}</div>
                    <span className="fs13 fw6 ell">{c.customer_name}</span>
                  </div>
                  <span className="mut fs12 ell">{c.items_summary}</span>
                  <span className="fs13 fw6">${(c.value_cents / 100).toFixed(2)}</span>
                  <span className="mut fs12">{new Date(c.last_activity_at).toLocaleString()}</span>
                  <span>
                    <span className={CART_BADGE[c.status].cls}>{CART_BADGE[c.status].label}</span>
                  </span>
                  <div>
                    {c.reminder_sent_note && <span className="fs12 mut">{c.reminder_sent_note}</span>}
                    {canSend && (
                      <button
                        className="btn sm"
                        disabled={sendReminder.isPending}
                        onClick={() =>
                          sendReminder.mutate(
                            { id: c.id },
                            {
                              // Say what actually happened, not what we hoped.
                              onSuccess: () => say("Reminder sent"),
                              onError: (err) =>
                                say(err instanceof Error ? err.message : "Couldn't send the reminder"),
                            }
                          )
                        }
                      >
                        {sendReminder.isPending ? "Sending…" : sendLabel}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

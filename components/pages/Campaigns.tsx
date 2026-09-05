"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CHANNELS, CAMPAIGN_BADGE, mapChannelType } from "@/lib/data";
import { useCampaigns } from "@/hooks/useCampaigns";
import { useBusinessGate } from "@/hooks/useCurrentBusinessId";
import { freshAccessToken } from "@/lib/supabase/session";
import { EmptyState, LoadingState, NotConnectedNotice } from "@/components/State";
import { useDashboardStore } from "@/store/useDashboardStore";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
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

export default function Campaigns() {
  const { businessId, missing } = useBusinessGate();
  const { data: camps, isLoading } = useCampaigns();
  const say = useDashboardStore((s) => s.say);
  const qc = useQueryClient();

  const [checkList, setCheckList] = useState<Check[]>([]);
  const [canSend, setCanSend] = useState(false);
  const [checksLoading, setChecksLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState({ name: "", templateName: "", scheduledAt: "" });
  const [saving, setSaving] = useState(false);

  // Readiness is computed from the shop's actual state, so it is asked for
  // rather than stored — a gate answered from a table someone filled in by
  // hand is not a gate.
  const loadChecks = useCallback(async () => {
    try {
      const payload = await call("/api/campaigns");
      setCheckList(payload.checks as Check[]);
      setCanSend(Boolean(payload.canSend));
    } catch (err) {
      say(err instanceof Error ? err.message : "Couldn't check whether you can send.");
    } finally {
      setChecksLoading(false);
    }
  }, [say]);

  useEffect(() => {
    if (businessId) void loadChecks();
  }, [businessId, loadChecks]);

  const notConnected = missing;
  const campaignList = camps || [];
  const failingCount = checkList.filter((c) => !c.ok).length;

  return (
    <div className="pwrap">
      <div className="page" data-screen-label="Campaigns">
        <div className="phead">
          <div>
            <h1 className="h1">Campaigns</h1>
            <p className="sub">
              Send one message to everyone who agreed to hear from you. Each item below is
              checked against your account, not ticked off by hand.
            </p>
          </div>
          <button
            className="btn-p"
            disabled={!canSend}
            title={canSend ? undefined : "Resolve the checks below first"}
            onClick={() => setComposing((open) => !open)}
          >
            {composing ? "Cancel" : "New campaign"}
          </button>
        </div>

        {notConnected && <NotConnectedNotice />}

        {composing && (
          <form
            className="card"
            style={{ padding: 16, marginBottom: 12 }}
            onSubmit={async (e) => {
              e.preventDefault();
              setSaving(true);
              try {
                const payload = await call("/api/campaigns", {
                  method: "POST",
                  body: JSON.stringify(draft),
                });
                say(payload.message as string);
                setDraft({ name: "", templateName: "", scheduledAt: "" });
                setComposing(false);
                qc.invalidateQueries({ queryKey: ["campaigns"] });
              } catch (err) {
                say(err instanceof Error ? err.message : "Couldn't schedule that campaign.");
              } finally {
                setSaving(false);
              }
            }}
          >
            <div className="fx ac gap8 wrap" style={{ marginBottom: 10 }}>
              <input
                className="inp"
                style={{ flex: "2 1 220px" }}
                required
                autoFocus
                placeholder="Campaign name, e.g. Eid sale"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <input
                className="inp"
                style={{ flex: "1 1 180px" }}
                required
                placeholder="Approved template name"
                value={draft.templateName}
                onChange={(e) => setDraft({ ...draft, templateName: e.target.value })}
              />
              <input
                className="inp"
                style={{ flex: "1 1 200px" }}
                type="datetime-local"
                value={draft.scheduledAt}
                onChange={(e) => setDraft({ ...draft, scheduledAt: e.target.value })}
              />
            </div>
            <button className="btn-p" type="submit" disabled={saving}>
              {saving ? "Scheduling…" : "Schedule campaign"}
            </button>
            <p className="mut fs12" style={{ marginTop: 10 }}>
              Everyone who has opted in receives it. Leave the time empty to send at the next run.
            </p>
          </form>
        )}

        <div className="card">
          <div className="cardh">
            Before you can broadcast
            {checkList.length > 0 && (
              <span className={failingCount ? "bdg warn" : "bdg ok"}>
                {failingCount ? `${failingCount} still to do` : "Ready to send"}
              </span>
            )}
          </div>
          {checksLoading ? (
            <LoadingState rows={2} />
          ) : (
            checkList.map((k) => (
              <div className="arow" key={k.name}>
                <div className={"ck " + (k.ok ? "ok" : "no")}>{k.ok ? "✓" : "✕"}</div>
                <div className="f1" style={{ minWidth: 0 }}>
                  <div className="fs13 fw6">{k.name}</div>
                  <div className="mut fs12 mt2">{k.detail}</div>
                  {k.fix && (
                    <div className="mut fs12 mt2">
                      <em>{k.fix}</em>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {isLoading ? (
          <div className="mt16"><LoadingState rows={3} /></div>
        ) : campaignList.length === 0 ? (
          <div className="card mt16">
            <EmptyState
              icon="📣"
              title="No campaigns yet"
              desc="Scheduled and sent broadcasts across WhatsApp, Messenger, Instagram, and web will show up here."
            />
          </div>
        ) : (
          <div className="card mt16">
            <div className="trow cprow hd">
              <span>Campaign</span>
              <span>Channel</span>
              <span>Target segment</span>
              <span>Scheduled</span>
              <span>Status</span>
              <span>Sent / failed</span>
            </div>
            {campaignList.map((c) => {
              const channelKey = mapChannelType(c.channel_type);
              const ch = CHANNELS[channelKey];
              return (
                <div className="trow cprow" key={c.id}>
                  <div style={{ minWidth: 0 }}>
                    <div className="fw6 fs13 ell">{c.name}</div>
                    {c.template_name && <div className="mut fs11 mono">{c.template_name}</div>}
                  </div>
                  <div className="fx ac gap8">
                    <div className={ch.cls}>{ch.ab}</div>
                    <span className="fs12">{ch.label}</span>
                  </div>
                  <span className="mono fs11 mut ell">{c.target_segment}</span>
                  <span className="mut fs12">{c.scheduled_at ? new Date(c.scheduled_at).toLocaleString() : "—"}</span>
                  <span>
                    <span className={CAMPAIGN_BADGE[c.status].cls}>{CAMPAIGN_BADGE[c.status].label}</span>
                  </span>
                  <span className="fs12">
                    {c.sent_count || 0} / {c.failed_count || 0}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function EmptyState({
  icon = "🗂️",
  title,
  desc,
}: {
  icon?: string;
  title: string;
  desc?: string;
}) {
  return (
    <div className="empty">
      <div className="empty-ic">{icon}</div>
      <div className="fw6 fs14">{title}</div>
      {desc && <div className="mut fs12 mt2" style={{ maxWidth: 360, textAlign: "center" }}>{desc}</div>}
    </div>
  );
}

export function LoadingState({ rows = 3 }: { rows?: number }) {
  return (
    <div className="col gap8" style={{ padding: 16 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skel" key={i} />
      ))}
    </div>
  );
}

export function NotConnectedNotice() {
  return (
    <div className="notice">
      This account isn&apos;t attached to a shop yet. Sign out and back in to finish setting one
      up — if it keeps saying this, your sign-in worked but no shop was created for it.
    </div>
  );
}

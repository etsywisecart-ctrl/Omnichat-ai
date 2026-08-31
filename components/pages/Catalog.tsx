"use client";

import { useRef } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import { useProducts, useToggleProduct } from "@/hooks/useProducts";
import { useUploadProducts } from "@/hooks/useProductsV2";
import { useCurrentBusinessId } from "@/hooks/useCurrentBusinessId";
import { EmptyState, LoadingState, NotConnectedNotice } from "@/components/State";

export default function Catalog() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: businessId, isLoading: bizLoading } = useCurrentBusinessId();
  const { data: prods, isLoading } = useProducts();
  const toggleProduct = useToggleProduct();
  const uploadProducts = useUploadProducts();
  const q = useDashboardStore((s) => s.q);
  const setQuery = useDashboardStore((s) => s.setQuery);
  const say = useDashboardStore((s) => s.say);

  const notConnected = !bizLoading && !businessId;
  const list = prods || [];
  const qq = q.trim().toLowerCase();
  const filtered = list.filter(
    (p) => !qq || p.name.toLowerCase().includes(qq) || (p.sku && p.sku.toLowerCase().includes(qq))
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      uploadProducts.mutate(file, {
        onSuccess: (r) =>
          say(
            `Imported ${r.imported} product${r.imported === 1 ? "" : "s"}` +
              (r.skipped ? ` · skipped ${r.skipped} row(s) with no name` : "")
          ),
        onError: (err) => say(err instanceof Error ? err.message : "Upload failed"),
      });
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleSyncClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="pwrap">
      <div className="page" data-screen-label="Catalog">
        <div className="phead">
          <div>
            <h1 className="h1">Catalog</h1>
            <p className="sub">What the agent can search, recommend, and sell in chat.</p>
          </div>
          <div className="fx ac gap8">
            <input
              className="inp"
              style={{ width: 210 }}
              placeholder="Search products…"
              value={q}
              onChange={(e) => setQuery(e.target.value)}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleFileSelect}
              style={{ display: "none" }}
            />
            <button
              className="btn"
              onClick={handleSyncClick}
              disabled={uploadProducts.isPending}
            >
              {uploadProducts.isPending ? "Uploading…" : "Sync catalog"}
            </button>
            <button className="btn-p" onClick={() => say("Wire this button to an insert into products")}>
              Add product
            </button>
          </div>
        </div>

        {notConnected && <NotConnectedNotice />}

        {isLoading ? (
          <LoadingState rows={5} />
        ) : list.length === 0 ? (
          <div className="card">
            <EmptyState
              icon="🛍️"
              title="No products yet"
              desc="Sync your CSV catalog or insert rows into the products table to see them here."
            />
          </div>
        ) : (
          <div className="card mt12">
            <div className="trow prow hd">
              <span>Product</span>
              <span>Price</span>
              <span>Source</span>
              <span>Updated</span>
              <span>Active</span>
            </div>
            {filtered.map((p) => {
              const init = p.name
                .split(" ")
                .map((w) => w[0])
                .slice(0, 2)
                .join("");
              return (
                <div className="trow prow" key={p.id}>
                  <div className="fx ac gap12" style={{ minWidth: 0 }}>
                    <div className="thumb" style={{ background: "#6f7a8a" }}>
                      {init}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="fw6 fs13 ell">{p.name}</div>
                      <div className="mut fs11 mono">{p.sku || "—"}</div>
                    </div>
                  </div>
                  <span className="fs13">${(p.price_cents / 100).toFixed(2)}</span>
                  <span>
                    <span className="ftag">{p.source}</span>
                  </span>
                  <span className="mut fs12">{new Date(p.updated_at).toLocaleDateString()}</span>
                  <button
                    className={"tgl" + (p.is_active ? " on" : "")}
                    onClick={() => toggleProduct.mutate({ id: p.id, isActive: !p.is_active })}
                    aria-label="Toggle active"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

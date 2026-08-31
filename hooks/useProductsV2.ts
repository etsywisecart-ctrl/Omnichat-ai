import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { useCurrentBusinessId } from "./useCurrentBusinessId";

export interface Product {
  id: string;
  business_id: string;
  name: string;
  sku?: string;
  description?: string;
  price_cents: number;
  currency: string;
  source: string;
  is_active: boolean;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export function useProducts() {
  const { data: businessId } = useCurrentBusinessId();
  return useQuery({
    queryKey: ["products", businessId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .eq("business_id", businessId as string)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data || []) as Product[];
    },
    enabled: Boolean(businessId),
  });
}

export function useToggleProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const { error } = await supabase
        .from("products")
        .update({ is_active: isActive, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
}

export function useUploadProducts() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (file: File) => {
      // The API reads the business from the access token, so the browser
      // never gets to say which business it is importing into.
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Sign in to upload a catalog");

      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/products/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || payload.error || "Upload failed");
      }

      return payload as { imported: number; skipped: number };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

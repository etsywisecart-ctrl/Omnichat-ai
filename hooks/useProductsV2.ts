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

export interface NewProduct {
  name: string;
  price: string;
  sku?: string;
  description?: string;
  currency?: string;
}

/**
 * Add one product by hand.
 *
 * The price arrives as typed ("32", "32.50", "$32") and is converted here, so
 * a shop owner never has to think in cents — the same rule the CSV importer
 * uses, kept identical on purpose.
 */
export function useCreateProduct() {
  const qc = useQueryClient();
  const { data: businessId } = useCurrentBusinessId();

  return useMutation({
    mutationFn: async (input: NewProduct) => {
      if (!businessId) throw new Error("No business is connected yet.");

      const name = input.name.trim();
      if (!name) throw new Error("Give the product a name.");

      const amount = Number.parseFloat((input.price || "").replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error("Enter a price, like 32.00");
      }

      // Matches the importer: a blank SKU becomes one derived from the name,
      // so a hand-added product can still be updated by a later CSV upload.
      const sku =
        input.sku?.trim() ||
        name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

      const { error } = await supabase.from("products").insert({
        business_id: businessId,
        name,
        sku,
        description: input.description?.trim() || null,
        price_cents: Math.round(amount * 100),
        currency: (input.currency || "USD").toUpperCase(),
        source: "manual",
        is_active: true,
      } as never);

      if (error) {
        // The unique index on (business_id, sku) is the usual cause, and
        // "duplicate key value violates..." helps nobody.
        if (error.code === "23505") {
          throw new Error(`A product with the code "${sku}" already exists.`);
        }
        throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
}

export interface ProductEdit {
  id: string;
  name: string;
  price: string;
  sku?: string;
  description?: string;
}

/**
 * Edit a product already in the catalog.
 *
 * Takes the price as typed and converts it here, exactly as the importer and
 * the add form do — three places a price is entered, one rule for reading it.
 */
export function useUpdateProduct() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: ProductEdit) => {
      const name = input.name.trim();
      if (!name) throw new Error("Give the product a name.");

      const amount = Number.parseFloat((input.price || "").replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error("Enter a price, like 32.00");
      }

      const { error } = await supabase
        .from("products")
        .update({
          name,
          sku: input.sku?.trim() || undefined,
          description: input.description?.trim() || null,
          price_cents: Math.round(amount * 100),
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id", input.id);

      if (error) {
        if (error.code === "23505") {
          throw new Error(`Another product already uses the code "${input.sku?.trim()}".`);
        }
        throw error;
      }
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

      return payload as {
        imported: number;
        skipped: number;
        skippedNoName: number;
        skippedNoPrice: number;
        renamed: number;
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

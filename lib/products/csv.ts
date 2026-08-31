/**
 * CSV catalog parsing.
 *
 * Pure functions, deliberately kept out of the route handler so they can be
 * tested directly — see tests/csv.test.ts. Every rule here exists because the
 * original importer got it wrong: it split on every comma, guessed whether a
 * number meant cents, and left SKUs blank.
 */
export interface CSVProduct {
  name: string;
  sku: string;
  price_cents: number;
  currency: string;
  description?: string;
}

/**
 * Split one CSV line, honouring quoted fields and "" escapes, so a comma
 * inside a description doesn't shift every remaining column.
 */
export function splitCSVLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(field.trim());
      field = "";
    } else field += ch;
  }

  out.push(field.trim());
  return out;
}

/**
 * Parse a money string into integer cents.
 *
 * The value is always read as a major-unit amount ("12", "12.50", "$1,299.00"),
 * never guessed. A `price_cents` column, if present, is used verbatim instead —
 * that's the unambiguous way to give exact cents.
 */
export function parseMoney(raw: string): number | null {
  const cleaned = (raw || "").replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/**
 * Derive a stable SKU from the product name, for rows that don't supply one.
 *
 * Every product needs a unique key so re-importing a CSV updates rows instead
 * of duplicating them. Deriving it from the name keeps it stable across
 * imports, and means the uniqueness index never has to allow blanks.
 */
export function skuFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || `item-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseCSV(csv: string): { products: CSVProduct[]; skipped: number } {
  const lines = csv.replace(/\r\n?/g, "\n").trim().split("\n");
  if (lines.length < 2) return { products: [], skipped: 0 };

  const headers = splitCSVLine(lines[0]).map((h) => h.toLowerCase());
  const products: CSVProduct[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const values = splitCSVLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });

    if (!row.name) {
      skipped++;
      continue;
    }

    // price_cents wins when supplied; otherwise read `price` as a normal
    // currency amount (12.50 -> 1250).
    let priceCents: number | null = null;
    if (row.price_cents) {
      const asInt = Number.parseInt(row.price_cents, 10);
      priceCents = Number.isFinite(asInt) && asInt >= 0 ? asInt : null;
    } else if (row.price) {
      priceCents = parseMoney(row.price);
    }

    if (priceCents === null) {
      skipped++;
      continue;
    }

    products.push({
      name: row.name,
      sku: row.sku || skuFromName(row.name),
      price_cents: priceCents,
      currency: (row.currency || "USD").toUpperCase(),
      description: row.description || undefined,
    });
  }

  return { products, skipped };
}

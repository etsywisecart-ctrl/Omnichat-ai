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
  /** Draft and unpublished products must not be quoted to customers. */
  is_active: boolean;
}

export interface ParseResult {
  products: CSVProduct[];
  skipped: number;
  /** Split out because "no name" and "no price" need different fixes. */
  skippedNoName: number;
  skippedNoPrice: number;
  /** The column titles actually found, so a mismatch can be shown, not guessed. */
  headers: string[];
  /** Which required columns could not be matched to anything. */
  missing: string[];
}

/**
 * Column titles real stores export, mapped to the ones we need.
 *
 * No shop exports a file with our column names. Shopify writes "Title" and
 * "Variant Price"; WooCommerce writes "Name" and "Regular price". Requiring
 * exactly `name` and `price` meant every genuine export failed with "no usable
 * rows" and left the shop owner renaming headers in a spreadsheet before they
 * could import their own catalog.
 *
 * Order matters: the first alias present in the file wins, so "Regular price"
 * is preferred over "Sale price" when a WooCommerce export carries both.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  name: ["name", "title", "product name", "product title", "item name", "product"],
  price: [
    "price",
    "regular price",
    "variant price",
    "unit price",
    "sale price",
    "price (incl. tax)",
  ],
  price_cents: ["price_cents", "price cents"],
  sku: ["sku", "variant sku", "product sku", "item sku"],
  description: [
    "description",
    "body (html)",
    "body_html",
    "body html",
    "short description",
    "product description",
    "body",
  ],
  currency: ["currency", "variant currency"],
  status: ["status", "published", "is_active", "active", "visibility"],
};

/** Values that mean "do not offer this to customers". */
const INACTIVE_VALUES = new Set([
  "draft",
  "archived",
  "private",
  "pending",
  "hidden",
  "false",
  "no",
  "0",
  "-1",
]);

/** Long store descriptions are HTML and can run to pages; the AI needs a line. */
const MAX_DESCRIPTION = 400;

/** Strip a byte-order mark and normalise spacing so headers compare reliably. */
function normaliseHeader(raw: string): string {
  return raw.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Match each column we need to a column in the file.
 *
 * Returns indexes rather than a keyed row so a file with two columns of the
 * same name cannot silently overwrite the one we picked.
 */
export function resolveColumns(headers: string[]): Record<string, number> {
  const normalised = headers.map(normaliseHeader);
  const found: Record<string, number> = {};

  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const index = normalised.indexOf(alias);
      if (index !== -1) {
        found[canonical] = index;
        break;
      }
    }
  }
  return found;
}

/**
 * Turn a store's rich-text description into one plain line.
 *
 * Shopify's "Body (HTML)" is literal HTML. Left alone it reaches the model as
 * markup, and a whole catalog of them crowds out the conversation itself.
 */
export function plainText(raw: string): string {
  const text = (raw || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6])>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= MAX_DESCRIPTION) return text;
  // Cut on a word so the AI never reads half a word aloud.
  return text.slice(0, MAX_DESCRIPTION).replace(/\s+\S*$/, "") + "…";
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

export function parseCSV(csv: string): ParseResult {
  const lines = csv.replace(/\r\n?/g, "\n").trim().split("\n");
  const empty: ParseResult = {
    products: [],
    skipped: 0,
    skippedNoName: 0,
    skippedNoPrice: 0,
    headers: [],
    missing: ["name", "price"],
  };
  if (lines.length < 2) return empty;

  const headers = splitCSVLine(lines[0]).map((h) => h.replace(/^\uFEFF/, "").trim());
  const columns = resolveColumns(headers);

  const missing: string[] = [];
  if (columns.name === undefined) missing.push("name");
  if (columns.price === undefined && columns.price_cents === undefined) missing.push("price");

  const products: CSVProduct[] = [];
  let skippedNoName = 0;
  let skippedNoPrice = 0;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const values = splitCSVLine(lines[i]);
    const at = (key: string): string =>
      columns[key] === undefined ? "" : (values[columns[key]] ?? "").trim();

    const row = {
      name: at("name"),
      price: at("price"),
      price_cents: at("price_cents"),
      sku: at("sku"),
      description: at("description"),
      currency: at("currency"),
      status: at("status"),
    };

    // Shopify repeats a product across rows for each variant and image, with
    // the title only on the first. Those continuation rows are not products.
    if (!row.name) {
      skippedNoName++;
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
      skippedNoPrice++;
      continue;
    }

    const description = plainText(row.description);

    products.push({
      name: row.name,
      sku: row.sku || skuFromName(row.name),
      price_cents: priceCents,
      currency: (row.currency || "USD").toUpperCase(),
      description: description || undefined,
      is_active: !INACTIVE_VALUES.has(row.status.toLowerCase()),
    });
  }

  return {
    products,
    skipped: skippedNoName + skippedNoPrice,
    skippedNoName,
    skippedNoPrice,
    headers,
    missing,
  };
}

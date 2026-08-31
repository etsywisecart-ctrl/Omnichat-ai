/**
 * Minimal RFC 4180 CSV reader.
 *
 * A plain `split(",")` breaks the moment a field contains a comma — which for
 * a product catalog means every description with a comma in it silently shifts
 * the remaining columns. This handles quoted fields, escaped quotes ("") and
 * both \n and \r\n line endings.
 */
export function parseCSV(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      // Swallow the \n of a \r\n pair.
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  // Flush whatever the last line left behind.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/**
 * Convert a price cell to integer cents.
 *
 * `centsColumn` says the sheet already holds cents, so the value is used
 * as-is. Otherwise the value is read as a normal currency amount — "12",
 * "12.50", "$1,299.00" all mean what a person would expect. There is no
 * guessing based on magnitude: a catalog priced at 150.00 is $150.00, not
 * $1.50.
 */
export function toCents(raw: string, centsColumn: boolean): number {
  const cleaned = (raw ?? "").replace(/[^0-9.\-]/g, "").trim();
  if (!cleaned) return 0;

  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value < 0) return 0;

  return centsColumn ? Math.round(value) : Math.round(value * 100);
}

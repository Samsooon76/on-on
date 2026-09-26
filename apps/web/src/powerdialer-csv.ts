import { normalizePhoneNumber } from "@onoff/contracts";
import type { DialerContact } from "./powerdialer-model";

export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_CSV_ROWS = 1000;
export type CsvData = { headers: string[]; rows: { line: number; cells: string[] }[]; delimiter: string };
export type CsvMapping = Record<"phone" | "name" | "firstName" | "company" | "email" | "notes", number>;
export type CsvIssue = { line: number; number: string; reason: string };

// RFC 4180 quoting, CRLF and multiline cells. Semicolons/tabs cover French Excel exports.
function readRows(text: string, delimiter: string): CsvData["rows"] {
  const rows: CsvData["rows"] = [];
  let cells: string[] = [], cell = "", quoted = false, closed = false, line = 1, firstLine = 1;
  const finishCell = () => { cells.push(cell.trim()); cell = ""; closed = false; };
  const finishRow = () => {
    finishCell();
    if (cells.some(Boolean)) rows.push({ line: firstLine, cells });
    if (rows.length > MAX_CSV_ROWS + 1) throw new Error(`Le fichier dépasse ${MAX_CSV_ROWS} contacts. Scindez-le en plusieurs fichiers.`);
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else { cell += ch; if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++; }
    } else if (ch === delimiter) finishCell();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      finishRow(); line++; firstLine = line;
    } else if (ch === '"' && !cell && !closed) quoted = true;
    else if (ch === '"' || (closed && ch.trim())) throw new Error(`Guillemets invalides à la ligne ${line}.`);
    else if (!closed) cell += ch;
    if (cell.length > 10000 || cells.length > 100) throw new Error("Le fichier contient une cellule trop longue ou plus de 100 colonnes.");
  }
  if (quoted) throw new Error(`Guillemets non fermés à la ligne ${firstLine}.`);
  if (cell || cells.length || closed) finishRow();
  return rows;
}
export function parseDialerCsv(input: string, hasHeader = true): CsvData {
  if (new TextEncoder().encode(input).byteLength > MAX_CSV_BYTES) throw new Error("Le fichier dépasse 2 Mo.");
  if (input.includes('\0') || input.includes('\uFFFD')) throw new Error("Enregistrez votre fichier CSV au format UTF-8.");
  let text = input.replace(/^\uFEFF/, "");
  // Excel sometimes prepends a separator directive.
  const directive = text.match(/^sep=([,;\t])\r?\n/i);
  if (directive) text = text.slice(directive[0].length);
  const firstRecord = text.match(/^(?:"(?:[^"]|"")*"|[^\r\n])*/)?.[0] ?? text;
  const counts = [",", ";", "\t"].map((separator) => {
    let quotes = false, count = 0;
    for (let i = 0; i < firstRecord.length; i++) { if (firstRecord[i] === '"') quotes = !quotes; else if (!quotes && firstRecord[i] === separator) count++; }
    return { separator, count };
  });
  const delimiter = directive?.[1] ?? counts.sort((a, b) => b.count - a.count)[0]!.separator;
  const records = readRows(text, delimiter);
  if (!records.length) throw new Error("Ce fichier est vide.");
  const headers = hasHeader ? records[0]!.cells.map((name, i) => name || `Colonne ${i + 1}`) : records[0]!.cells.map((_, i) => `Colonne ${i + 1}`);
  if (headers.length > 100) throw new Error("Le fichier dépasse 100 colonnes.");
  const rows = hasHeader ? records.slice(1) : records;
  if (!rows.length) throw new Error("Le fichier contient uniquement les en-têtes, sans contact.");
  if (rows.length > MAX_CSV_ROWS) throw new Error(`Le fichier dépasse ${MAX_CSV_ROWS} contacts.`);
  return { headers, rows, delimiter };
}
export function suggestCsvMapping(headers: string[]): CsvMapping {
  const normalized = headers.map((header) => header.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[_-]/g, " ").trim());
  const match = (aliases: string[]) => normalized.findIndex((name) => aliases.includes(name));
  return {
    phone: match(["telephone", "tel", "phone", "phone number", "mobile", "numero", "numero de telephone", "portable", "number"]),
    name: match(["nom complet", "full name", "name", "nom", "last name", "lastname", "contact", "display name"]),
    firstName: match(["prenom", "first name", "firstname"]),
    company: match(["entreprise", "company", "societe", "organization"]),
    email: match(["email", "e mail", "e-mail", "mail", "courriel"]),
    notes: match(["notes", "note", "commentaire", "commentaires", "description"]),
  };
}
export function prepareCsvImport(data: CsvData, mapping: CsvMapping, existing: string[], excluded: string[], nationalFormat: "FR" | "international", source: string): { contacts: DialerContact[]; issues: CsvIssue[]; invalid: number; duplicates: number; excluded: number } {
  const contacts: DialerContact[] = [], issues: CsvIssue[] = [];
  const seen = new Set(existing), blocked = new Set(excluded);
  let invalid = 0, duplicates = 0, exclusions = 0;
  if (mapping.phone < 0 || mapping.phone >= data.headers.length) return { contacts, issues, invalid, duplicates, excluded: exclusions };
  for (const row of data.rows) {
    const read = (field: keyof CsvMapping) => row.cells[mapping[field]]?.trim() ?? "";
    const raw = read("phone");
    const number = nationalFormat === "international" && !/^(\+|00)/.test(raw) ? null : normalizePhoneNumber(raw);
    let reason = "";
    if (row.cells.length !== data.headers.length) { invalid++; reason = "Nombre de colonnes différent des en-têtes"; }
    else if (!number) { invalid++; reason = "Numéro invalide ou indicatif manquant"; }
    else if (blocked.has(number)) { exclusions++; reason = "Ne plus appeler · numéro exclu"; }
    else if (seen.has(number)) { duplicates++; reason = "Doublon dans le fichier ou la campagne"; }
    if (reason || !number) { issues.push({ line: row.line, number: raw, reason }); continue; }
    if (read("notes").length > 5000 || [read("name"), read("firstName"), read("company"), read("email")].some((value) => value.length > 250)) {
      invalid++; issues.push({ line: row.line, number: raw, reason: "Champ trop long (250 caractères, ou 5 000 pour les notes)" }); continue;
    }
    seen.add(number);
    contacts.push({ id: number, contactId: null, name: [read("firstName"), read("name")].filter(Boolean).join(" ") || number, number, email: read("email") || null, company: read("company"), initialNotes: read("notes"), phoneLabel: "", source });
  }
  return { contacts, issues, invalid, duplicates, excluded: exclusions };
}
// Neutralize spreadsheet formulas, including leading whitespace/control characters.
export function csvText(rows: unknown[][]): string {
  return '\uFEFF' + rows.map((row) => row.map((value) => {
    let text = String(value ?? "");
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }).join(";")).join("\r\n");
}
export const csvTemplate = '\uFEFFnom;prenom;telephone;entreprise;email;notes\r\nMartin;Camille;0600000000;Exemple;camille@example.com;Contact de démonstration à remplacer\r\n';

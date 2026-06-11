# Supplier Packing List Format Map

Used by `POST /api/jhonny/pl-checkup` in 305-workspace/server.js to parse Excel PL files from Drive AWB folders.

**Key PO DETAIL sheet columns (original order quantities):**
- Sheet ID: `1y0iL7PJldbVQmPIAnJi9wvA2hvjB8_aK2bU2kxvUf5Q`, tab: `PO DETAIL`
- `Purchase Order` → PO number
- `Size Desc Desc` (double "Desc" — intentional) → size label (XS, S, M, L, XL...)
- `Allocated (Prepack) Qty` → ordered qty per size per PO

---

## HS FASHION ✅ Fully Mapped

**File naming:** `INV AND PL [INVOICE#].xls`
**Tab structure:** Tab 1 = Commercial Invoice; Tabs 2+ = Packing List (named `[STYLE#] packing list`)

**Packing List tabs:**
- Row 8: STYLE NO. | value | PO NO. | all POs concatenated with /
- Rows 12–13: Split column headers
- PO sub-header rows appear before each PO's carton section with text `PO# XXXXXXXX`
- Col A/C: Carton start/end#
- **Col D: QTY CTN (carton multiplier)**
- Col E: Color (ignore)
- **Col F=XXS, G=XS, H=S, I=M, J=L, K=XL, L=XXL** (1-indexed: cols 6–12)
- Col M: TOTAL PCS
- Footer: TOTAL row + summary

**Formula:** `suppQty[size] = sum(size_qty × QTY_CTN)` across all carton rows for that PO
**PO format:** Numeric (e.g. 62010000), strip "PO#" prefix when matching

**Parser in server.js:** `parsePLHSFashion()` — checks tab names contain "packing list", col D=multiplier, cols 6–12=sizes

---

## H&F ⬜ Format Pending

**Sample sheet:** `15cbmj6diLCHNSnkb35t8i30Zi5crHBmx` gid=1390838136
**Discover:** `GET /api/jhonny/analyze-pl-sheet?sheetId=15cbmj6diLCHNSnkb35t8i30Zi5crHBmx&gid=1390838136`
**Parser:** Generic (auto-detect size headers) until format is documented.

---

## GAIA ⬜ Format Pending

**Samples (3 files — likely consistent format):**
- `1IIyC1VPl1SiPZYmdLmX0bqkMgpsco6mk` gid=1512293103
- `13f5OxTCeyzn6hrYes5Bitw6MaqFLF-jE` gid=1584843997
- `1ywH2uH_-BPyTZoa7YVCzvjm96TGrzIuJ` gid=1623690249

**Discover:** `GET /api/jhonny/analyze-pl-sheet?sheetId=1IIyC1VPl1SiPZYmdLmX0bqkMgpsco6mk&gid=1512293103`
**Parser:** Generic until documented.

---

## ECICO ⬜ Format Pending

**Sample sheet:** `1Nudhq22rojQeorxFC1mlFPVzIbvo690Y` (first/default tab)
**Discover:** `GET /api/jhonny/analyze-pl-sheet?sheetId=1Nudhq22rojQeorxFC1mlFPVzIbvo690Y`
**Parser:** Generic until documented.

---

## KONCEPTION (KON) ⬜ Format Pending

**Sample sheet:** `14v3NffXNdtEV3wN9G0-DkFvGIMUKDfAu` gid=1096062987
**Discover:** `GET /api/jhonny/analyze-pl-sheet?sheetId=14v3NffXNdtEV3wN9G0-DkFvGIMUKDfAu&gid=1096062987`
**Parser:** Generic until documented.

---

## SAINTS & SEERS (S&S) ⬜ Format Pending

**Sample sheet:** `1Yq7rV7wGhQhQayeHrVoyJh0nZzSI8gK6` gid=455864767
**Discover:** `GET /api/jhonny/analyze-pl-sheet?sheetId=1Yq7rV7wGhQhQayeHrVoyJh0nZzSI8gK6&gid=455864767`
**Parser:** Generic until documented.

---

## Pending (no samples yet)

- **JJ** — no sample file shared
- **PQSWIM** — no sample file shared
- **CASCADE** — no sample file shared

---

## Generic Parser Logic (fallback for all unmapped suppliers)

`parsePLGenericExcelJS()` / `parsePLGenericXLSX()` in 305-workspace/server.js:

1. Scan first 50 rows for a row with ≥3 cells matching known size labels:
   `XXS / XS / S / M / L / XL / XXL / 2XL / 3XL / 1X / 2X / 3X / 0 / 2 / 4 / 6 / 8 / 10 / 12 / 14 / 16`
2. If PO sections exist (detected by `/PO[#\s]*\d{6,}/i` sub-headers), isolate current PO rows
3. Use TOTAL row if present; otherwise sum all data rows
4. Carton multiplier: tries col 4 (D), caps at 499; defaults to 1

---

## How to Document a New Supplier

After deploy, call the analyze endpoint (requires being logged into workspace305team.onrender.com):

```
GET https://workspace305team.onrender.com/api/jhonny/analyze-pl-sheet?sheetId=SHEET_ID&gid=TAB_GID
```

Returns first 60 rows + all tab names. Look for:
- Which row has size headers (S/M/L/XL etc.)
- Which column is the carton/quantity multiplier
- How PO sections are labeled
- Which column is TOTAL

Then add a specific parser function like `parsePLHSFashion()` and update `parsePLFile()` to try it when `supplier` matches.

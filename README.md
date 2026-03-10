# Rail Peak Wizard

Responsive local TypeScript app for:

- uploading a railroad measurement workbook
- loading all sheets into DuckDB immediately after upload
- configuring sheet and column peak rules
- calculating initial peaks
- reviewing each graph one by one
- dragging peak markers to custom positions
- downloading the final Excel workbook in the same `Wheel + columns` layout as `output/section-1-sharp-curve-3-site-analysis-40-wheel-peaks-max.xlsx`

## Stack

- React + TypeScript + Vite
- Express + TypeScript
- DuckDB
- ExcelJS
- XLSX

## Start

1. Install dependencies:

```bash
npm install
```

2. Start the local client and server together:

```bash
npm run dev
```

3. Open the Vite URL shown in the terminal, usually:

```text
http://127.0.0.1:5173
```

## Workflow

1. Upload an Excel workbook.
2. Configure included sheets, included columns, time column, multiply-by value, peak mode, and peak count.
3. Click `Calculate peaks`.
4. Review graphs one by one and drag the red peak markers.
5. Change `Multiply by` or `Peak mode` during review if needed. Doing that recalculates the graph and resets any custom placements for that graph.
6. Click `Download as Excel`.

## Notes

- The server loads sheet CSVs into DuckDB as soon as the workbook is uploaded.
- Export filenames match the old Python-style pattern when the analysis is uniform, for example:

```text
section-1-sharp-curve-3-site-analysis-40-wheel-peaks-max.xlsx
```

- If the final review mixes different modes or peak counts across columns, the export filename falls back to:

```text
<workbook>-custom-wheel-peaks.xlsx
```

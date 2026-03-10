import cors from "cors";
import duckdb from "duckdb";
import ExcelJS from "exceljs";
import express from "express";
import multer from "multer";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";
import * as XLSX from "xlsx";
import { z } from "zod";

import { applyMultiplier, selectPeakIndices } from "./peakDetection.js";
import type {
  AnalysisItemConfiguration,
  AnalysisItemState,
  AnalysisSession,
  PeakMode,
  PreparedSeriesPoint,
  ReviewItemPayload,
  WorkbookSession,
  WorkbookSheetData,
  WorkbookSummary,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const port = Number(process.env.PORT ?? 3001);

const workbookSessions = new Map<string, WorkbookSession>();
const analysisSessions = new Map<string, AnalysisSession>();

const defaultIncludedColumn = (columnName: string): boolean => !columnName.toLowerCase().startsWith("unnamed:");
const defaultIncludedSheet = (sheetName: string): boolean => !sheetName.toLowerCase().startsWith("sheet");

const analysisItemSchema = z.object({
  sheetName: z.string().min(1),
  columnName: z.string().min(1),
  timeColumn: z.string().min(1),
  multiplyBy: z.number().finite(),
  peakMode: z.enum(["max", "min", "both"]),
  peakCount: z.number().int().positive().max(500),
});

const createAnalysisSchema = z.object({
  items: z.array(analysisItemSchema).min(1),
});

const recomputeSchema = z.object({
  multiplyBy: z.number().finite(),
  peakMode: z.enum(["max", "min", "both"]),
  peakCount: z.number().int().positive().max(500).optional(),
});

const customPeaksSchema = z.object({
  peakIndices: z.array(z.number().int().nonnegative()).min(1),
});

app.use(cors());
app.use(express.json({ limit: "25mb" }));

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "sheet";
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function buildContentDisposition(filename: string): string {
  const fallback = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/["\\]/g, "_")
    .replace(/[;]+/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "export.xlsx";
  const encoded = encodeURIComponent(filename)
    .replace(/['()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function detectTimeColumn(headers: string[]): string {
  const match = headers.find((header) => header.toLowerCase().includes("time"));
  return match ?? headers[0] ?? "Time";
}

function toHeader(value: unknown, index: number): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return `Unnamed: ${index}`;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getWorkbookSession(workbookId: string): WorkbookSession {
  const session = workbookSessions.get(workbookId);
  if (!session) {
    throw new Error(`Unknown workbook: ${workbookId}`);
  }
  return session;
}

function getAnalysisSession(analysisId: string): AnalysisSession {
  const session = analysisSessions.get(analysisId);
  if (!session) {
    throw new Error(`Unknown analysis: ${analysisId}`);
  }
  return session;
}

function getSheet(session: WorkbookSession, sheetName: string): WorkbookSheetData {
  const sheet = session.sheets.find((candidate) => candidate.name === sheetName);
  if (!sheet) {
    throw new Error(`Unknown sheet: ${sheetName}`);
  }
  return sheet;
}

function getPreparedSeries(
  session: WorkbookSession,
  sheetName: string,
  timeColumn: string,
  valueColumn: string,
): PreparedSeriesPoint[] {
  const cacheKey = `${sheetName}::${timeColumn}::${valueColumn}`;
  const cached = session.preparedSeriesCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const sheet = getSheet(session, sheetName);
  const timeIndex = sheet.headers.indexOf(timeColumn);
  const valueIndex = sheet.headers.indexOf(valueColumn);
  if (timeIndex === -1 || valueIndex === -1) {
    return [];
  }

  const prepared: PreparedSeriesPoint[] = [];
  for (let rowIndex = 1; rowIndex < sheet.rows.length; rowIndex += 1) {
    const row = sheet.rows[rowIndex] ?? [];
    const time = coerceNumber(row[timeIndex]);
    const value = coerceNumber(row[valueIndex]);
    if (time === null || value === null) {
      continue;
    }
    prepared.push({
      sourceRow: rowIndex + 1,
      time,
      value,
    });
  }

  session.preparedSeriesCache.set(cacheKey, prepared);
  return prepared;
}

function computePeakIndicesForItem(session: WorkbookSession, item: AnalysisItemConfiguration): number[] {
  const prepared = getPreparedSeries(session, item.sheetName, item.timeColumn, item.columnName);
  const transformed = applyMultiplier(
    prepared.map((point) => point.value),
    item.multiplyBy,
  );
  return selectPeakIndices(transformed, item.peakCount, item.peakMode);
}

function getActivePeakIndices(item: AnalysisItemState): number[] {
  return item.customPeakIndices ?? item.defaultPeakIndices;
}

function buildReviewPayload(workbook: WorkbookSession, item: AnalysisItemState): ReviewItemPayload {
  const prepared = getPreparedSeries(workbook, item.sheetName, item.timeColumn, item.columnName);
  const transformed = applyMultiplier(
    prepared.map((point) => point.value),
    item.multiplyBy,
  );
  const peakIndices = getActivePeakIndices(item);

  return {
    id: item.id,
    sheetName: item.sheetName,
    columnName: item.columnName,
    timeColumn: item.timeColumn,
    multiplyBy: item.multiplyBy,
    peakMode: item.peakMode,
    peakCount: item.peakCount,
    customized: item.customized,
    points: prepared.map((point, index) => ({
      index,
      time: point.time,
      value: point.value,
    })),
    peaks: peakIndices.map((index) => ({
      index,
      time: prepared[index]?.time ?? Number.NaN,
      value: prepared[index]?.value ?? Number.NaN,
      transformedValue: transformed[index] ?? Number.NaN,
    })),
  };
}

function deriveExportFilename(workbook: WorkbookSession, analysis: AnalysisSession): string {
  const counts = new Set(analysis.items.map((item) => getActivePeakIndices(item).length));
  const modes = new Set<PeakMode>(analysis.items.map((item) => item.peakMode));

  if (counts.size === 1 && modes.size === 1) {
    const [count] = counts;
    const [mode] = modes;
    return `${workbook.workbookStem}-${count}-wheel-peaks-${mode}.xlsx`;
  }

  return `${workbook.workbookStem}-custom-wheel-peaks.xlsx`;
}

async function buildExportWorkbook(workbook: WorkbookSession, analysis: AnalysisSession): Promise<Buffer> {
  const excel = new ExcelJS.Workbook();

  for (const sheet of workbook.sheets) {
    const sheetItems = analysis.items.filter((item) => item.sheetName === sheet.name);
    if (sheetItems.length === 0) {
      continue;
    }

    const worksheet = excel.addWorksheet(sheet.name.slice(0, 31));
    worksheet.addRow(["Wheel", ...sheetItems.map((item) => item.columnName)]);

    const peakValuesByColumn = sheetItems.map((item) => {
      const prepared = getPreparedSeries(workbook, item.sheetName, item.timeColumn, item.columnName);
      return getActivePeakIndices(item).map((index) => prepared[index]?.value ?? null);
    });

    const maxRows = Math.max(...peakValuesByColumn.map((values) => values.length), 0);
    for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
      worksheet.addRow([
        rowIndex + 1,
        ...peakValuesByColumn.map((values) => values[rowIndex] ?? null),
      ]);
    }
  }

  const buffer = await excel.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function dbRun(database: any, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    database.run(sql, (error: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function loadWorkbookIntoDuckDb(database: any, sheets: WorkbookSheetData[]): Promise<void> {
  for (const sheet of sheets) {
    await dbRun(
      database,
      `CREATE TABLE "${sheet.tableName}" AS SELECT * FROM read_csv_auto('${escapeSqlString(
        sheet.csvPath,
      )}', header=true, all_varchar=true, sample_size=-1, ignore_errors=true);`,
    );
  }
}

async function createWorkbookSession(fileName: string, buffer: Buffer): Promise<WorkbookSession> {
  const workbookId = uuidv4();
  const workbook = XLSX.read(buffer, { type: "buffer", dense: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rail-peak-wizard-"));
  await mkdir(tempDir, { recursive: true });

  const sheets: WorkbookSheetData[] = [];

  for (const [index, sheetName] of workbook.SheetNames.entries()) {
    const worksheet = workbook.Sheets[sheetName];
    const rows = (XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    }) as unknown[][]).map((row) => [...row]);

    const headers = (rows[0] ?? []).map((value, columnIndex) => toHeader(value, columnIndex));
    const normalizedRows = rows.map((row, rowIndex) => {
      if (rowIndex === 0) {
        return headers;
      }
      return headers.map((_, columnIndex) => row[columnIndex] ?? null);
    });

    const csvPath = path.join(tempDir, `${index + 1}-${sanitizeSegment(sheetName)}.csv`);
    const csv = XLSX.utils.sheet_to_csv(worksheet, { blankrows: false });
    await writeFile(csvPath, csv, "utf8");

    sheets.push({
      name: sheetName,
      tableName: `sheet_${index + 1}_${sanitizeSegment(sheetName)}`,
      csvPath,
      headers,
      rows: normalizedRows,
      defaultTimeColumn: detectTimeColumn(headers),
    });
  }

  const database = new (duckdb as any).Database(":memory:");
  await loadWorkbookIntoDuckDb(database, sheets);

  return {
    id: workbookId,
    fileName,
    workbookStem: fileName.replace(/\.[^.]+$/, ""),
    tempDir,
    uploadedAt: Date.now(),
    sheets,
    preparedSeriesCache: new Map<string, PreparedSeriesPoint[]>(),
    db: database,
  };
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/api/workbooks/upload", upload.single("file"), async (request, response) => {
  try {
    const file = request.file;
    if (!file) {
      response.status(400).json({ error: "Missing file upload" });
      return;
    }

    const session = await createWorkbookSession(file.originalname, file.buffer);
    workbookSessions.set(session.id, session);

    const summary: WorkbookSummary = {
      workbookId: session.id,
      fileName: session.fileName,
      sheets: session.sheets.map((sheet) => ({
        name: sheet.name,
        defaultIncluded: defaultIncludedSheet(sheet.name),
        defaultTimeColumn: sheet.defaultTimeColumn,
        columns: sheet.headers.map((header) => ({
          name: header,
          defaultIncluded: defaultIncludedColumn(header),
        })),
      })),
    };

    response.json(summary);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Upload failed" });
  }
});

app.post("/api/workbooks/:workbookId/analyses", async (request, response) => {
  try {
    const workbook = getWorkbookSession(request.params.workbookId);
    const parsed = createAnalysisSchema.parse(request.body);

    const items: AnalysisItemState[] = parsed.items.map((item) => ({
      ...item,
      id: uuidv4(),
      defaultPeakIndices: computePeakIndicesForItem(workbook, item),
      customPeakIndices: null,
      customized: false,
    }));

    const analysis: AnalysisSession = {
      id: uuidv4(),
      workbookId: workbook.id,
      createdAt: Date.now(),
      items,
    };
    analysisSessions.set(analysis.id, analysis);

    response.json({
      analysisId: analysis.id,
      items: analysis.items.map((item) => ({
        id: item.id,
        sheetName: item.sheetName,
        columnName: item.columnName,
        timeColumn: item.timeColumn,
        multiplyBy: item.multiplyBy,
        peakMode: item.peakMode,
        peakCount: item.peakCount,
        customized: item.customized,
        peaksFound: item.defaultPeakIndices.length,
      })),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: error.flatten() });
      return;
    }
    response.status(500).json({ error: error instanceof Error ? error.message : "Analysis failed" });
  }
});

app.get("/api/analyses/:analysisId/items/:itemId", (request, response) => {
  try {
    const analysis = getAnalysisSession(request.params.analysisId);
    const workbook = getWorkbookSession(analysis.workbookId);
    const item = analysis.items.find((candidate) => candidate.id === request.params.itemId);
    if (!item) {
      response.status(404).json({ error: "Unknown analysis item" });
      return;
    }
    response.json(buildReviewPayload(workbook, item));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Failed to load review item" });
  }
});

app.patch("/api/analyses/:analysisId/items/:itemId/recompute", async (request, response) => {
  try {
    const analysis = getAnalysisSession(request.params.analysisId);
    const workbook = getWorkbookSession(analysis.workbookId);
    const item = analysis.items.find((candidate) => candidate.id === request.params.itemId);
    if (!item) {
      response.status(404).json({ error: "Unknown analysis item" });
      return;
    }

    const parsed = recomputeSchema.parse(request.body);
    item.multiplyBy = parsed.multiplyBy;
    item.peakMode = parsed.peakMode;
    item.peakCount = parsed.peakCount ?? item.peakCount;
    item.defaultPeakIndices = computePeakIndicesForItem(workbook, item);
    item.customPeakIndices = null;
    item.customized = false;

    response.json(buildReviewPayload(workbook, item));
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: error.flatten() });
      return;
    }
    response.status(500).json({ error: error instanceof Error ? error.message : "Failed to recompute peaks" });
  }
});

app.patch("/api/analyses/:analysisId/items/:itemId/custom-peaks", (request, response) => {
  try {
    const analysis = getAnalysisSession(request.params.analysisId);
    const workbook = getWorkbookSession(analysis.workbookId);
    const item = analysis.items.find((candidate) => candidate.id === request.params.itemId);
    if (!item) {
      response.status(404).json({ error: "Unknown analysis item" });
      return;
    }

    const parsed = customPeaksSchema.parse(request.body);
    const prepared = getPreparedSeries(workbook, item.sheetName, item.timeColumn, item.columnName);

    const uniqueSorted = [...new Set(parsed.peakIndices)].sort((left, right) => left - right);
    if (uniqueSorted.some((index) => index < 0 || index >= prepared.length)) {
      response.status(400).json({ error: "Peak indices out of range" });
      return;
    }

    item.customPeakIndices = uniqueSorted;
    item.customized = true;

    response.json(buildReviewPayload(workbook, item));
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: error.flatten() });
      return;
    }
    response.status(500).json({ error: error instanceof Error ? error.message : "Failed to save custom peaks" });
  }
});

app.get("/api/analyses/:analysisId/export", async (request, response) => {
  try {
    const analysis = getAnalysisSession(request.params.analysisId);
    const workbook = getWorkbookSession(analysis.workbookId);
    const buffer = await buildExportWorkbook(workbook, analysis);
    const filename = deriveExportFilename(workbook, analysis);

    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", buildContentDisposition(filename));
    response.send(buffer);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Failed to export workbook" });
  }
});

app.listen(port, () => {
  console.log(`Rail Peak Wizard API listening on http://127.0.0.1:${port}`);
  console.log(`Server root: ${path.resolve(__dirname, "..")}`);
});

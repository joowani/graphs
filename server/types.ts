export type PeakMode = "max" | "min" | "both";

export interface WorkbookColumnSummary {
  name: string;
  defaultIncluded: boolean;
}

export interface WorkbookSheetSummary {
  name: string;
  columns: WorkbookColumnSummary[];
  defaultIncluded: boolean;
  defaultTimeColumn: string;
}

export interface WorkbookSummary {
  workbookId: string;
  fileName: string;
  sheets: WorkbookSheetSummary[];
}

export interface WorkbookSheetData {
  name: string;
  tableName: string;
  csvPath: string;
  headers: string[];
  rows: unknown[][];
  defaultTimeColumn: string;
}

export interface PreparedSeriesPoint {
  sourceRow: number;
  time: number;
  value: number;
}

export interface WorkbookSession {
  id: string;
  fileName: string;
  workbookStem: string;
  tempDir: string;
  uploadedAt: number;
  sheets: WorkbookSheetData[];
  preparedSeriesCache: Map<string, PreparedSeriesPoint[]>;
  db: unknown;
}

export interface AnalysisItemConfiguration {
  sheetName: string;
  columnName: string;
  timeColumn: string;
  multiplyBy: number;
  peakMode: PeakMode;
  peakCount: number;
}

export interface AnalysisItemState extends AnalysisItemConfiguration {
  id: string;
  defaultPeakIndices: number[];
  customPeakIndices: number[] | null;
  customized: boolean;
}

export interface AnalysisSession {
  id: string;
  workbookId: string;
  items: AnalysisItemState[];
  createdAt: number;
}

export interface ReviewPoint {
  index: number;
  time: number;
  value: number;
}

export interface ReviewPeak {
  index: number;
  time: number;
  value: number;
  transformedValue: number;
}

export interface ReviewItemPayload {
  id: string;
  sheetName: string;
  columnName: string;
  timeColumn: string;
  multiplyBy: number;
  peakMode: PeakMode;
  peakCount: number;
  customized: boolean;
  points: ReviewPoint[];
  peaks: ReviewPeak[];
}

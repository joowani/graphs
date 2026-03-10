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

export interface ColumnConfiguration {
  enabled: boolean;
  multiplyBy: number;
  peakMode: PeakMode;
  peakCount: number;
}

export interface SheetConfiguration {
  enabled: boolean;
  timeColumn: string;
  columns: Record<string, ColumnConfiguration>;
}

export interface AnalysisItemSummary {
  id: string;
  sheetName: string;
  columnName: string;
  timeColumn: string;
  multiplyBy: number;
  peakMode: PeakMode;
  peakCount: number;
  customized: boolean;
  peaksFound: number;
}

export interface AnalysisSummary {
  analysisId: string;
  items: AnalysisItemSummary[];
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

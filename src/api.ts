import type {
  AnalysisSummary,
  ReviewItemPayload,
  WorkbookSummary,
} from "./types";

async function handleJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error ?? response.statusText);
  }
  return (await response.json()) as T;
}

export async function uploadWorkbook(file: File): Promise<WorkbookSummary> {
  const form = new FormData();
  form.append("file", file);

  const response = await fetch("/api/workbooks/upload", {
    method: "POST",
    body: form,
  });

  return handleJson<WorkbookSummary>(response);
}

export async function createAnalysis(workbookId: string, body: unknown): Promise<AnalysisSummary> {
  const response = await fetch(`/api/workbooks/${workbookId}/analyses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return handleJson<AnalysisSummary>(response);
}

export async function getReviewItem(analysisId: string, itemId: string): Promise<ReviewItemPayload> {
  const response = await fetch(`/api/analyses/${analysisId}/items/${itemId}`);
  return handleJson<ReviewItemPayload>(response);
}

export async function recomputeReviewItem(
  analysisId: string,
  itemId: string,
  body: unknown,
): Promise<ReviewItemPayload> {
  const response = await fetch(`/api/analyses/${analysisId}/items/${itemId}/recompute`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleJson<ReviewItemPayload>(response);
}

export async function saveCustomPeaks(
  analysisId: string,
  itemId: string,
  peakIndices: number[],
): Promise<ReviewItemPayload> {
  const response = await fetch(`/api/analyses/${analysisId}/items/${itemId}/custom-peaks`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ peakIndices }),
  });
  return handleJson<ReviewItemPayload>(response);
}

export function exportAnalysisUrl(analysisId: string): string {
  return `/api/analyses/${analysisId}/export`;
}

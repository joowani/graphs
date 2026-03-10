import { useEffect, useMemo, useState } from "react";

import {
  createAnalysis,
  exportAnalysisUrl,
  getReviewItem,
  recomputeReviewItem,
  saveCustomPeaks,
  uploadWorkbook,
} from "./api";
import { PeakReviewChart } from "./components/PeakReviewChart";
import type {
  AnalysisSummary,
  ColumnConfiguration,
  PeakMode,
  ReviewItemPayload,
  SheetConfiguration,
  WorkbookSummary,
} from "./types";

type WizardStep = "upload" | "configure" | "processing" | "review";

function buildInitialConfiguration(summary: WorkbookSummary): Record<string, SheetConfiguration> {
  return Object.fromEntries(
    summary.sheets.map((sheet) => [
      sheet.name,
      {
        enabled: sheet.defaultIncluded,
        timeColumn: sheet.defaultTimeColumn,
        columns: Object.fromEntries(
          sheet.columns.map((column) => [
            column.name,
            {
              enabled: column.defaultIncluded,
              multiplyBy: 1,
              peakMode: "max",
              peakCount: 40,
            } satisfies ColumnConfiguration,
          ]),
        ),
      } satisfies SheetConfiguration,
    ]),
  );
}

function summarizeColumns(configuration: Record<string, SheetConfiguration>): number {
  return Object.values(configuration).reduce((count, sheet) => {
    if (!sheet.enabled) {
      return count;
    }
    return (
      count +
      Object.entries(sheet.columns).filter(
        ([columnName, column]) => column.enabled && columnName !== sheet.timeColumn,
      ).length
    );
  }, 0);
}

interface EditableNumberInputProps {
  value: number;
  onCommit: (value: number) => void;
  step?: string;
  min?: number;
  max?: number;
  integer?: boolean;
  disabled?: boolean;
}

function EditableNumberInput({
  value,
  onCommit,
  step,
  min,
  max,
  integer = false,
  disabled = false,
}: EditableNumberInputProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    const parsed = integer ? Number.parseInt(trimmed, 10) : Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }

    let nextValue = integer ? Math.round(parsed) : parsed;
    if (min !== undefined) {
      nextValue = Math.max(min, nextValue);
    }
    if (max !== undefined) {
      nextValue = Math.min(max, nextValue);
    }

    setDraft(String(nextValue));
    if (nextValue !== value) {
      onCommit(nextValue);
    }
  };

  return (
    <input
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      value={draft}
      step={step}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
        }
        if (event.key === "Escape") {
          setDraft(String(value));
        }
      }}
    />
  );
}

function App() {
  const [step, setStep] = useState<WizardStep>("upload");
  const [workbook, setWorkbook] = useState<WorkbookSummary | null>(null);
  const [configuration, setConfiguration] = useState<Record<string, SheetConfiguration>>({});
  const [analysis, setAnalysis] = useState<AnalysisSummary | null>(null);
  const [reviewCache, setReviewCache] = useState<Record<string, ReviewItemPayload>>({});
  const [currentItemId, setCurrentItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [isGraphRefreshing, setIsGraphRefreshing] = useState(false);
  const [reviewSettings, setReviewSettings] = useState<{ multiplyBy: number; peakMode: PeakMode; peakCount: number }>({
    multiplyBy: 1,
    peakMode: "max",
    peakCount: 40,
  });

  const currentReview = currentItemId ? reviewCache[currentItemId] ?? null : null;
  const currentSummary = useMemo(
    () => analysis?.items.find((item) => item.id === currentItemId) ?? null,
    [analysis, currentItemId],
  );
  const columnsToProcess = useMemo(() => summarizeColumns(configuration), [configuration]);
  const isUploadBusy = step === "upload" && busyMessage !== null;
  const reviewSettingsDirty = Boolean(
    currentReview &&
      (currentReview.multiplyBy !== reviewSettings.multiplyBy ||
        currentReview.peakMode !== reviewSettings.peakMode ||
        currentReview.peakCount !== reviewSettings.peakCount),
  );

  useEffect(() => {
    if (!currentReview) {
      return;
    }
    setReviewSettings({
      multiplyBy: currentReview.multiplyBy,
      peakMode: currentReview.peakMode,
      peakCount: currentReview.peakCount,
    });
  }, [currentReview]);

  useEffect(() => {
    if (!analysis || !currentItemId || !currentReview) {
      setIsGraphRefreshing(false);
      return;
    }
    if (
      currentReview.multiplyBy === reviewSettings.multiplyBy &&
      currentReview.peakMode === reviewSettings.peakMode &&
      currentReview.peakCount === reviewSettings.peakCount
    ) {
      setIsGraphRefreshing(false);
      return;
    }

    setIsGraphRefreshing(true);
    const timer = window.setTimeout(async () => {
      try {
        const refreshed = await recomputeReviewItem(analysis.analysisId, currentItemId, {
          multiplyBy: reviewSettings.multiplyBy,
          peakMode: reviewSettings.peakMode,
          peakCount: reviewSettings.peakCount,
        });
        setReviewCache((current) => ({ ...current, [refreshed.id]: refreshed }));
        setAnalysis((current) =>
          current
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.id === refreshed.id
                    ? {
                        ...item,
                        multiplyBy: refreshed.multiplyBy,
                        peakMode: refreshed.peakMode,
                        peakCount: refreshed.peakCount,
                        customized: false,
                        peaksFound: refreshed.peaks.length,
                      }
                    : item,
                ),
              }
            : current,
        );
        setError(null);
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Failed to recalculate graph");
      } finally {
        setIsGraphRefreshing(false);
      }
    }, 350);

    return () => window.clearTimeout(timer);
  }, [analysis, currentItemId, currentReview, reviewSettings]);

  async function handleUpload(file: File) {
    setBusyMessage("Uploading workbook and loading sheets into DuckDB...");
    setError(null);
    try {
      const summary = await uploadWorkbook(file);
      setWorkbook(summary);
      setConfiguration(buildInitialConfiguration(summary));
      setAnalysis(null);
      setReviewCache({});
      setCurrentItemId(null);
      setStep("configure");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to upload workbook");
    } finally {
      setBusyMessage(null);
    }
  }

  function resetToUpload() {
    setStep("upload");
    setWorkbook(null);
    setConfiguration({});
    setAnalysis(null);
    setReviewCache({});
    setCurrentItemId(null);
    setReviewSettings({ multiplyBy: 1, peakMode: "max", peakCount: 40 });
    setError(null);
    setBusyMessage(null);
  }

  async function startAnalysis() {
    if (!workbook) {
      return;
    }

    const items = Object.entries(configuration).flatMap(([sheetName, sheet]) => {
      if (!sheet.enabled) {
        return [];
      }

      return Object.entries(sheet.columns)
        .filter(([columnName, column]) => column.enabled && columnName !== sheet.timeColumn)
        .map(([columnName, column]) => ({
          sheetName,
          columnName,
          timeColumn: sheet.timeColumn,
          multiplyBy: column.multiplyBy,
          peakMode: column.peakMode,
          peakCount: column.peakCount,
        }));
    });

    if (items.length === 0) {
      setError("Choose at least one measurement column.");
      return;
    }

    setBusyMessage("Calculating initial peaks for all selected columns...");
    setStep("processing");
    setError(null);
    try {
      const summary = await createAnalysis(workbook.workbookId, { items });
      setAnalysis(summary);
      setCurrentItemId(summary.items[0]?.id ?? null);
      setReviewCache({});
      if (summary.items[0]) {
        const first = await getReviewItem(summary.analysisId, summary.items[0].id);
        setReviewCache({ [first.id]: first });
      }
      setStep("review");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to analyze workbook");
      setStep("configure");
    } finally {
      setBusyMessage(null);
    }
  }

  async function selectReviewItem(itemId: string) {
    if (!analysis) {
      return;
    }
    setCurrentItemId(itemId);
    if (reviewCache[itemId]) {
      return;
    }

    setBusyMessage("Loading graph...");
    try {
      const payload = await getReviewItem(analysis.analysisId, itemId);
      setReviewCache((current) => ({ ...current, [payload.id]: payload }));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to load graph");
    } finally {
      setBusyMessage(null);
    }
  }

  async function handlePeakCommit(peakIndices: number[]) {
    if (!analysis || !currentItemId) {
      return;
    }
    setBusyMessage("Saving custom peak placement...");
    try {
      const updated = await saveCustomPeaks(analysis.analysisId, currentItemId, peakIndices);
      setReviewCache((current) => ({ ...current, [updated.id]: updated }));
      setAnalysis((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.id === updated.id
                  ? { ...item, customized: true, peaksFound: updated.peaks.length }
                  : item,
              ),
            }
          : current,
      );
      setError(null);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to save custom peaks");
    } finally {
      setBusyMessage(null);
    }
  }

  const currentIndex = useMemo(() => {
    if (!analysis || !currentItemId) {
      return -1;
    }
    return analysis.items.findIndex((item) => item.id === currentItemId);
  }, [analysis, currentItemId]);

  const previousItem = currentIndex > 0 && analysis ? analysis.items[currentIndex - 1] : null;
  const nextItem = analysis && currentIndex >= 0 && currentIndex < analysis.items.length - 1 ? analysis.items[currentIndex + 1] : null;

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-title">
          <h1>Peak Finder</h1>
        </div>
        <div className="hero-actions">
          {step === "review" ? (
            <button className="secondary-button" onClick={() => setStep("configure")} type="button">
              Back to Configuration
            </button>
          ) : null}
          {workbook ? (
            <button className="secondary-button" onClick={resetToUpload} type="button">
              Choose Another File
            </button>
          ) : null}
          {analysis && step === "review" ? (
            <a className="download-link" href={exportAnalysisUrl(analysis.analysisId)}>
              Download as Excel
            </a>
          ) : null}
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}
      {busyMessage && !isUploadBusy ? <div className="busy-banner">{busyMessage}</div> : null}

      {step === "upload" ? (
        <section className="panel panel-upload">
          <div className="upload-card">
            <p className="step-label">Step 1</p>
            <h2>Choose File</h2>
            <label className={`upload-dropzone ${isUploadBusy ? "is-disabled" : ""}`}>
              <input
                type="file"
                accept=".xlsx,.xlsm"
                disabled={isUploadBusy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void handleUpload(file);
                  }
                }}
              />
              <span>Choose an Excel workbook</span>
              <small>The file is uploaded once and fully loaded into DuckDB before configuration starts.</small>
            </label>
            {isUploadBusy ? (
              <div className="upload-overlay" aria-live="polite">
                <div className="upload-overlay-card">
                  <div className="spinner" aria-hidden="true" />
                  <strong>Loading workbook...</strong>
                  <span>{busyMessage}</span>
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {workbook && step === "configure" ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="step-label">Step 2</p>
              <h2>Configuration</h2>
              <p className="muted">Choose Sheets and Columns</p>
            </div>
            <div className="pill">{columnsToProcess} Columns to process</div>
          </div>

          <div className="sheet-stack">
            {workbook.sheets.map((sheet) => {
              const current = configuration[sheet.name];
              if (!current) {
                return null;
              }
              return (
                <details key={sheet.name} className="sheet-card" open={current.enabled}>
                  <summary>
                    <div>
                      <strong>{sheet.name}</strong>
                      <span>
                        {
                          Object.entries(current.columns).filter(
                            ([columnName, column]) => column.enabled && columnName !== current.timeColumn,
                          ).length
                        }{" "}
                        columns selected
                      </span>
                    </div>
                    <label className="toggle-inline" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={current.enabled}
                        onChange={(event) =>
                          setConfiguration((state) => ({
                            ...state,
                            [sheet.name]: { ...state[sheet.name], enabled: event.target.checked },
                          }))
                        }
                      />
                      Include sheet
                    </label>
                  </summary>

                  <div className="sheet-body">
                    <label className="field">
                      <span>Time column</span>
                      <select
                        value={current.timeColumn}
                        onChange={(event) =>
                          setConfiguration((state) => ({
                            ...state,
                            [sheet.name]: { ...state[sheet.name], timeColumn: event.target.value },
                          }))
                        }
                      >
                        {sheet.columns.map((column) => (
                          <option key={column.name} value={column.name}>
                            {column.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="column-table">
                      <div className="column-table-header">
                        <span>Include</span>
                        <span>Column</span>
                        <span>Multiply by</span>
                        <span>Peak mode</span>
                        <span>Peak count</span>
                      </div>
                      {sheet.columns
                        .filter((column) => column.name !== current.timeColumn)
                        .map((column) => {
                          const columnConfig = current.columns[column.name];
                          return (
                            <div className="column-row" key={column.name}>
                              <label className="column-include">
                                <input
                                  type="checkbox"
                                  checked={columnConfig.enabled}
                                  onChange={(event) =>
                                    setConfiguration((state) => ({
                                      ...state,
                                      [sheet.name]: {
                                        ...state[sheet.name],
                                        columns: {
                                          ...state[sheet.name].columns,
                                          [column.name]: {
                                            ...state[sheet.name].columns[column.name],
                                            enabled: event.target.checked,
                                          },
                                        },
                                      },
                                    }))
                                  }
                                />
                              </label>
                              <div className="column-name-cell">{column.name}</div>

                              <label className="field">
                                <span className="sr-only">Multiply by</span>
                                <EditableNumberInput
                                  value={columnConfig.multiplyBy}
                                  step="0.1"
                                  onCommit={(next) =>
                                    setConfiguration((state) => ({
                                      ...state,
                                      [sheet.name]: {
                                        ...state[sheet.name],
                                        columns: {
                                          ...state[sheet.name].columns,
                                          [column.name]: {
                                            ...state[sheet.name].columns[column.name],
                                            multiplyBy: next,
                                          },
                                        },
                                      },
                                    }))
                                  }
                                />
                              </label>

                              <label className="field">
                                <span className="sr-only">Peak mode</span>
                                <select
                                  value={columnConfig.peakMode}
                                  onChange={(event) =>
                                    setConfiguration((state) => ({
                                      ...state,
                                      [sheet.name]: {
                                        ...state[sheet.name],
                                        columns: {
                                          ...state[sheet.name].columns,
                                          [column.name]: {
                                            ...state[sheet.name].columns[column.name],
                                            peakMode: event.target.value as ColumnConfiguration["peakMode"],
                                          },
                                        },
                                      },
                                    }))
                                  }
                                >
                                  <option value="max">max</option>
                                  <option value="min">min</option>
                                  <option value="both">both</option>
                                </select>
                              </label>

                              <label className="field">
                                <span className="sr-only">Peak count</span>
                                <EditableNumberInput
                                  value={columnConfig.peakCount}
                                  integer
                                  min={1}
                                  max={500}
                                  onCommit={(next) =>
                                    setConfiguration((state) => ({
                                      ...state,
                                      [sheet.name]: {
                                        ...state[sheet.name],
                                        columns: {
                                          ...state[sheet.name].columns,
                                          [column.name]: {
                                            ...state[sheet.name].columns[column.name],
                                            peakCount: next,
                                          },
                                        },
                                      },
                                    }))
                                  }
                                />
                              </label>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                </details>
              );
            })}
          </div>

          <div className="footer-actions">
            <button className="primary-button" onClick={() => void startAnalysis()}>
              Calculate peaks
            </button>
          </div>
        </section>
      ) : null}

      {step === "processing" ? (
        <section className="panel panel-upload">
          <div className="upload-card">
            <p className="step-label">Step 3</p>
            <h2>Calculating Peaks</h2>
            <p className="hero-copy">
              The workbook is loaded. The server is calculating initial peak candidates for every selected sheet and column now.
            </p>
          </div>
        </section>
      ) : null}

      {analysis && step === "review" ? (
        <section className="panel review-layout">
          <aside className="review-sidebar">
            <div className="panel-header compact">
              <div>
                <p className="step-label">Step 3</p>
                <h2>Review Graphs</h2>
              </div>
              <div className="pill">
                {currentIndex + 1} / {analysis.items.length}
              </div>
            </div>

            <div className="review-list">
              {analysis.items.map((item) => (
                <button
                  key={item.id}
                  className={`review-list-item ${item.id === currentItemId ? "active" : ""}`}
                  onClick={() => void selectReviewItem(item.id)}
                >
                  <strong>{item.columnName}</strong>
                  <span>{item.sheetName}</span>
                  <small>{item.customized ? "Custom peaks" : `${item.peaksFound} peaks`}</small>
                </button>
              ))}
            </div>
          </aside>

          <div className="review-stage">
            {currentReview && currentSummary ? (
              <>
                <div className="panel-header">
                  <div>
                    <h2>{currentReview.columnName}</h2>
                    <p className="muted">{currentReview.sheetName}</p>
                  </div>
                  <div className="nav-inline">
                    <button disabled={!previousItem} onClick={() => previousItem && void selectReviewItem(previousItem.id)}>
                      Previous
                    </button>
                    <button disabled={!nextItem} onClick={() => nextItem && void selectReviewItem(nextItem.id)}>
                      Next
                    </button>
                  </div>
                </div>

                <div className="review-controls">
                  <label className="field">
                    <span>Multiply by</span>
                    <EditableNumberInput
                      value={reviewSettings.multiplyBy}
                      step="0.1"
                      onCommit={(next) => setReviewSettings((current) => ({ ...current, multiplyBy: next }))}
                    />
                  </label>
                  <label className="field">
                    <span>Peak mode</span>
                    <select
                      value={reviewSettings.peakMode}
                      onChange={(event) =>
                        setReviewSettings((current) => ({
                          ...current,
                          peakMode: event.target.value as ColumnConfiguration["peakMode"],
                        }))
                      }
                    >
                      <option value="max">max</option>
                      <option value="min">min</option>
                      <option value="both">both</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Peak count</span>
                    <EditableNumberInput
                      value={reviewSettings.peakCount}
                      integer
                      min={1}
                      max={500}
                      onCommit={(next) => setReviewSettings((current) => ({ ...current, peakCount: next }))}
                    />
                  </label>
                  <div className="stat-box">
                    <span>Status</span>
                    <strong>{currentSummary.customized ? "Custom" : "Auto"}</strong>
                  </div>
                  <div className="stat-box">
                    <span>Detected peaks</span>
                    <strong>{currentSummary.peaksFound}</strong>
                  </div>
                </div>

                <div className="review-chart-frame">
                  {(isGraphRefreshing || reviewSettingsDirty) ? (
                    <div className="review-chart-overlay" aria-live="polite">
                      <div className="review-chart-overlay-card">
                        <div className="spinner" aria-hidden="true" />
                        <strong>Updating graph...</strong>
                      </div>
                    </div>
                  ) : null}
                  <PeakReviewChart
                    points={currentReview.points}
                    multiplyBy={reviewSettings.multiplyBy}
                    peakMode={reviewSettings.peakMode}
                    peakIndices={currentReview.peaks.map((peak) => peak.index)}
                    onPeakCommit={(peakIndices) => void handlePeakCommit(peakIndices)}
                  />
                </div>

                <div className="peak-table">
                  <div className="peak-table-header">
                    <span>#</span>
                    <span>Time</span>
                    <span>Original</span>
                    <span>Transformed</span>
                  </div>
                  {currentReview.peaks.map((peak, index) => (
                    <div className="peak-table-row" key={`${peak.index}-${index}`}>
                      <span>{index + 1}</span>
                      <span>{peak.time.toFixed(4)}</span>
                      <span>{peak.value.toFixed(3)}</span>
                      <span>{peak.transformedValue.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="empty-state">Choose a graph from the list to review it.</div>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export default App;

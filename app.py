from __future__ import annotations

import io
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import altair as alt
import duckdb
import pandas as pd
import streamlit as st

from main import PEAK_MODES, select_peak_indices


st.set_page_config(page_title="Rail Peak Wizard", page_icon="🛤️", layout="wide")


@dataclass
class WorkbookContext:
    source_label: str
    source_bytes: bytes
    metadata: pd.DataFrame
    sheets: dict[str, pd.DataFrame]
    time_candidates: dict[str, str]


def _table_name(prefix: str, value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_]+", "_", value).strip("_").lower()
    return f"{prefix}_{cleaned or 'item'}"


def _load_source_bytes(upload: Any) -> tuple[str, bytes] | None:
    if upload is not None:
        return upload.name, upload.getvalue()
    return None


def _detect_time_column(columns: list[str]) -> str:
    for column in columns:
        if "time" in column.lower():
            return column
    return columns[0]


@st.cache_data(show_spinner=False)
def _load_workbook_payload(source_label: str, source_bytes: bytes) -> dict[str, Any]:
    excel_buffer = io.BytesIO(source_bytes)
    workbook = pd.ExcelFile(excel_buffer)
    connection = duckdb.connect(database=":memory:")

    metadata_rows: list[dict[str, Any]] = []
    sheets: dict[str, pd.DataFrame] = {}
    time_candidates: dict[str, str] = {}

    for sheet_name in workbook.sheet_names:
        frame = pd.read_excel(io.BytesIO(source_bytes), sheet_name=sheet_name, header=0)
        frame = frame.loc[:, ~frame.columns.isna()]
        frame.columns = [str(column) for column in frame.columns]
        sheets[sheet_name] = frame

        time_column = _detect_time_column(frame.columns.tolist())
        time_candidates[sheet_name] = time_column
        for column_name in frame.columns:
            metadata_rows.append(
                {
                    "sheet_name": sheet_name,
                    "column_name": column_name,
                    "is_time_candidate": column_name == time_column,
                    "row_count": len(frame),
                }
            )

    metadata = pd.DataFrame(metadata_rows)
    connection.register("metadata_df", metadata)
    connection.execute("CREATE OR REPLACE TABLE workbook_metadata AS SELECT * FROM metadata_df")
    metadata = connection.execute(
        """
        SELECT
            sheet_name,
            column_name,
            is_time_candidate,
            row_count
        FROM workbook_metadata
        ORDER BY sheet_name, column_name
        """
    ).df()

    return {
        "source_label": source_label,
        "source_bytes": source_bytes,
        "metadata": metadata,
        "sheets": sheets,
        "time_candidates": time_candidates,
    }


def load_workbook_context(source_label: str, source_bytes: bytes) -> WorkbookContext:
    payload = _load_workbook_payload(source_label, source_bytes)
    return WorkbookContext(
        source_label=payload["source_label"],
        source_bytes=payload["source_bytes"],
        metadata=payload["metadata"],
        sheets=payload["sheets"],
        time_candidates=payload["time_candidates"],
    )


def _default_sheet_enabled(sheet_name: str) -> bool:
    return not sheet_name.lower().startswith("sheet")


def _default_column_enabled(column_name: str) -> bool:
    return not column_name.lower().startswith("unnamed:")


def _get_sheet_scope(context: WorkbookContext) -> dict[str, dict[str, Any]]:
    scope: dict[str, dict[str, Any]] = {}
    for sheet_name, frame in context.sheets.items():
        columns = frame.columns.tolist()
        scope[sheet_name] = {
            "enabled": st.session_state.get(f"scope_sheet_{sheet_name}", _default_sheet_enabled(sheet_name)),
            "time_column": st.session_state.get(f"time_column_{sheet_name}", context.time_candidates[sheet_name]),
            "columns": [
                column
                for column in columns
                if st.session_state.get(f"scope_column_{sheet_name}_{column}", _default_column_enabled(column))
            ],
        }
    return scope


def _apply_transformations(series: pd.Series, flip: bool) -> tuple[pd.Series, float]:
    factor = -1.0 if flip else 1.0
    return series * factor, factor


def _prepare_numeric_series(frame: pd.DataFrame, time_column: str, value_column: str) -> pd.DataFrame:
    prepared = pd.DataFrame(
        {
            "time": pd.to_numeric(frame[time_column], errors="coerce"),
            "value": pd.to_numeric(frame[value_column], errors="coerce"),
        }
    )
    prepared = prepared.dropna(subset=["time", "value"]).reset_index(names="source_row")
    return prepared


def _build_export_workbook(results_table: pd.DataFrame) -> bytes:
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        summary_columns = [
            "sheet_name",
            "column_name",
            "peak_order",
            "time",
            "original_value",
            "transformed_value",
            "peak_mode",
            "transform_factor",
        ]
        results_table[summary_columns].to_excel(writer, index=False, sheet_name="Peak Summary")

        for sheet_name, group in results_table.groupby("sheet_name", sort=False):
            max_peaks = int(group["peak_order"].max())
            sheet_frame = pd.DataFrame({"Peak": range(1, max_peaks + 1)})
            for column_name, column_group in group.groupby("column_name", sort=False):
                values = column_group.sort_values("peak_order")["original_value"].tolist()
                if len(values) < max_peaks:
                    values.extend([None] * (max_peaks - len(values)))
                sheet_frame[column_name] = values
            sheet_frame.to_excel(writer, index=False, sheet_name=sheet_name[:31])
    return output.getvalue()


def run_analysis(context: WorkbookContext, scope: dict[str, dict[str, Any]]) -> tuple[pd.DataFrame, bytes]:
    result_rows: list[dict[str, Any]] = []

    for sheet_name, sheet_scope in scope.items():
        if not sheet_scope["enabled"]:
            continue

        frame = context.sheets[sheet_name]
        time_column = sheet_scope["time_column"]
        for column_name in sheet_scope["columns"]:
            if column_name == time_column:
                continue

            flip = bool(st.session_state.get(f"config_flip_{sheet_name}_{column_name}", False))
            peak_mode = st.session_state[f"config_peak_mode_{sheet_name}_{column_name}"]
            peak_count = int(st.session_state[f"config_peak_count_{sheet_name}_{column_name}"])

            prepared = _prepare_numeric_series(frame, time_column, column_name)
            if prepared.empty:
                continue

            transformed, factor = _apply_transformations(prepared["value"], flip)
            peak_indices = select_peak_indices(transformed.to_numpy(), peak_count, peak_mode)

            for order, idx in enumerate(peak_indices, start=1):
                row = prepared.iloc[idx]
                result_rows.append(
                    {
                        "sheet_name": sheet_name,
                        "column_name": column_name,
                        "peak_order": order,
                        "source_row": int(row["source_row"]),
                        "time": float(row["time"]),
                        "original_value": float(row["value"]),
                        "transformed_value": float(transformed.iloc[idx]),
                        "peak_mode": peak_mode,
                        "transform_factor": factor,
                    }
                )

    results_df = pd.DataFrame(result_rows)
    if results_df.empty:
        return results_df, b""

    connection = duckdb.connect(database=":memory:")
    connection.register("results_df", results_df)
    connection.execute("CREATE OR REPLACE TABLE peak_results AS SELECT * FROM results_df")
    ordered_results = connection.execute(
        """
        SELECT
            sheet_name,
            column_name,
            peak_order,
            source_row,
            time,
            original_value,
            transformed_value,
            peak_mode,
            transform_factor
        FROM peak_results
        ORDER BY sheet_name, column_name, peak_order
        """
    ).df()

    workbook_bytes = _build_export_workbook(ordered_results)
    return ordered_results, workbook_bytes


def render_source_picker() -> WorkbookContext | None:
    st.subheader("Step 1. Choose File")
    upload = st.file_uploader("Upload an Excel workbook", type=["xlsx", "xlsm"])

    source = _load_source_bytes(upload)
    if not source:
        st.info("Upload a workbook to continue.")
        return None

    source_label, source_bytes = source
    context = load_workbook_context(source_label, source_bytes)

    st.caption(f"Loaded workbook: `{context.source_label}`")

    return context


def render_configuration_step(context: WorkbookContext) -> dict[str, dict[str, Any]]:
    st.subheader("Step 2. Configure Analysis")
    st.caption("Choose Sheets and Columns")

    for sheet_name, frame in context.sheets.items():
        sheet_enabled_key = f"scope_sheet_{sheet_name}"
        if sheet_enabled_key not in st.session_state:
            st.session_state[sheet_enabled_key] = _default_sheet_enabled(sheet_name)
        if f"time_column_{sheet_name}" not in st.session_state:
            st.session_state[f"time_column_{sheet_name}"] = context.time_candidates[sheet_name]

        with st.expander(sheet_name, expanded=st.session_state[sheet_enabled_key]):
            st.checkbox("Include sheet", key=sheet_enabled_key)
            st.selectbox(
                "Time column for plotting",
                options=frame.columns.tolist(),
                key=f"time_column_{sheet_name}",
            )

            current_time_column = st.session_state[f"time_column_{sheet_name}"]
            for column_name in frame.columns.tolist():
                if column_name == current_time_column:
                    st.caption(f"Time column: `{column_name}`")
                    continue

                column_key = f"scope_column_{sheet_name}_{column_name}"
                if column_key not in st.session_state:
                    st.session_state[column_key] = _default_column_enabled(column_name)

                row_cols = st.columns([1.8, 0.8, 1.0, 0.9])
                with row_cols[0]:
                    st.checkbox(f"Column: {column_name}", key=column_key)
                with row_cols[1]:
                    st.checkbox("Flip", key=f"config_flip_{sheet_name}_{column_name}")
                with row_cols[2]:
                    st.selectbox(
                        "Peak mode",
                        options=PEAK_MODES,
                        key=f"config_peak_mode_{sheet_name}_{column_name}",
                    )
                with row_cols[3]:
                    st.number_input(
                        "Peak count",
                        min_value=1,
                        max_value=500,
                        value=40,
                        step=1,
                        key=f"config_peak_count_{sheet_name}_{column_name}",
                    )

    scope = _get_sheet_scope(context)
    scoped_columns = sum(
        len([column for column in values["columns"] if column != values["time_column"]])
        for values in scope.values()
        if values["enabled"]
    )
    st.caption(f"Columns to process: {scoped_columns}")
    return scope


def render_results_step(context: WorkbookContext, scope: dict[str, dict[str, Any]]) -> None:
    st.subheader("Step 3. Run, Review, and Export")

    run_now = st.button("Run analysis", type="primary")
    if run_now:
        with st.spinner("Running peak detection..."):
            results_df, workbook_bytes = run_analysis(context, scope)
        st.session_state["results_df"] = results_df
        st.session_state["results_workbook_bytes"] = workbook_bytes

    results_df = st.session_state.get("results_df")
    workbook_bytes = st.session_state.get("results_workbook_bytes", b"")

    if results_df is None:
        st.info("Run the analysis to generate charts and export data.")
        return

    if results_df.empty:
        st.warning("No peaks were produced for the current configuration.")
        return

    connection = duckdb.connect(database=":memory:")
    connection.register("results_df", results_df)
    summary = connection.execute(
        """
        SELECT
            sheet_name,
            column_name,
            count(*) AS peaks_found,
            min(time) AS first_peak_time,
            max(time) AS last_peak_time
        FROM results_df
        GROUP BY 1, 2
        ORDER BY 1, 2
        """
    ).df()
    st.dataframe(summary, width="stretch", hide_index=True)

    download_name = f"{Path(context.source_label).stem or 'peak-results'}-wizard-output.xlsx"
    st.download_button(
        "Download Excel results",
        data=workbook_bytes,
        file_name=download_name,
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        disabled=not workbook_bytes,
    )

    for sheet_name, sheet_group in results_df.groupby("sheet_name", sort=False):
        st.markdown(f"### {sheet_name}")
        frame = context.sheets[sheet_name]
        time_column = scope[sheet_name]["time_column"]

        for column_name, column_group in sheet_group.groupby("column_name", sort=False):
            prepared = _prepare_numeric_series(frame, time_column, column_name)
            if prepared.empty:
                continue

            chart_source = prepared.rename(columns={"time": "Time", "value": "Value"})
            peaks_source = column_group.rename(
                columns={
                    "time": "Time",
                    "original_value": "Value",
                }
            )

            line = alt.Chart(chart_source).mark_line(color="#1f77b4").encode(
                x=alt.X("Time:Q", title=time_column),
                y=alt.Y("Value:Q", title=column_name),
            )
            peaks = alt.Chart(peaks_source).mark_circle(color="#d62728", size=75).encode(
                x="Time:Q",
                y="Value:Q",
                tooltip=[
                    alt.Tooltip("peak_order:Q", title="Peak #"),
                    alt.Tooltip("Time:Q", title="Time"),
                    alt.Tooltip("Value:Q", title="Original value"),
                    alt.Tooltip("transformed_value:Q", title="Transformed value"),
                    alt.Tooltip("peak_mode:N", title="Mode"),
                    alt.Tooltip("transform_factor:Q", title="Transform factor"),
                ],
            )

            st.markdown(f"**{column_name}**")
            st.altair_chart((line + peaks).interactive(), width="stretch")


def main() -> None:
    st.title("Rail Peak Wizard")
    st.caption("Scope sheets and columns, configure transformations and peak rules, then review charts and export Excel.")

    context = render_source_picker()
    if context is None:
        return

    scope = render_configuration_step(context)
    render_results_step(context, scope)


if __name__ == "__main__":
    main()

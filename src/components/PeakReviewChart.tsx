import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type {
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
} from "react";

import type { ReviewPoint } from "../types";

interface PeakReviewChartProps {
  points: ReviewPoint[];
  peakIndices: number[];
  onPeakCommit: (peakIndices: number[]) => void;
}

interface Size {
  width: number;
  height: number;
}

const MARGIN = { top: 24, right: 24, bottom: 48, left: 72 };

function extent(values: number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    return [min - 1, max + 1];
  }
  return [min, max];
}

function linearScale(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const slope = (r1 - r0) / (d1 - d0);
  return {
    toRange: (value: number) => r0 + (value - d0) * slope,
    toDomain: (value: number) => d0 + (value - r0) / slope,
  };
}

function useElementSize<T extends HTMLElement>(): [MutableRefObject<T | null>, Size] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: 960, height: 520 });

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      setSize({
        width: Math.max(entry.contentRect.width, 320),
        height: Math.max(entry.contentRect.height, 360),
      });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}

function downsample(points: ReviewPoint[], maxPoints = 1800): ReviewPoint[] {
  if (points.length <= maxPoints) {
    return points;
  }

  const bucketSize = Math.ceil(points.length / maxPoints);
  const sampled: ReviewPoint[] = [];
  for (let start = 0; start < points.length; start += bucketSize) {
    const bucket = points.slice(start, Math.min(start + bucketSize, points.length));
    let minPoint = bucket[0];
    let maxPoint = bucket[0];
    for (const point of bucket) {
      if (point.value < minPoint.value) {
        minPoint = point;
      }
      if (point.value > maxPoint.value) {
        maxPoint = point;
      }
    }
    sampled.push(minPoint, maxPoint);
  }

  return [...new Map(sampled.sort((a, b) => a.index - b.index).map((point) => [point.index, point])).values()];
}

function buildLinePath(
  points: ReviewPoint[],
  xScale: ReturnType<typeof linearScale>,
  yScale: ReturnType<typeof linearScale>,
) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${xScale.toRange(point.time)},${yScale.toRange(point.value)}`)
    .join(" ");
}

function nearestPointIndex(points: ReviewPoint[], targetTime: number): number {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].time < targetTime) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const candidate = low;
  const previous = Math.max(0, candidate - 1);
  return Math.abs(points[candidate].time - targetTime) < Math.abs(points[previous].time - targetTime)
    ? points[candidate].index
    : points[previous].index;
}

function clampDomain(
  nextDomain: [number, number],
  minTime: number,
  maxTime: number,
  minSpan: number,
): [number, number] {
  const fullSpan = maxTime - minTime;
  let [start, end] = nextDomain;
  let span = end - start;

  if (span >= fullSpan) {
    return [minTime, maxTime];
  }

  if (span < minSpan) {
    const midpoint = (start + end) / 2;
    start = midpoint - minSpan / 2;
    end = midpoint + minSpan / 2;
    span = minSpan;
  }

  if (start < minTime) {
    start = minTime;
    end = minTime + span;
  }
  if (end > maxTime) {
    end = maxTime;
    start = maxTime - span;
  }

  return [start, end];
}

export function PeakReviewChart({ points, peakIndices, onPeakCommit }: PeakReviewChartProps) {
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [draftPeaks, setDraftPeaks] = useState<number[]>(peakIndices);
  const [activePeak, setActivePeak] = useState<number | null>(null);
  const [panStart, setPanStart] = useState<{ clientX: number; domain: [number, number] } | null>(null);
  const draftRef = useRef<number[]>(peakIndices);
  const pendingPeakRef = useRef<{ peakOrder: number; index: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  const times = useMemo(() => points.map((point) => point.time), [points]);
  const values = useMemo(() => points.map((point) => point.value), [points]);
  const [minTime, maxTime] = useMemo(() => extent(times), [times]);
  const [xDomain, setXDomain] = useState<[number, number]>([minTime, maxTime]);

  useEffect(() => {
    setDraftPeaks(peakIndices);
    draftRef.current = peakIndices;
  }, [peakIndices]);

  useEffect(() => {
    setXDomain([minTime, maxTime]);
  }, [minTime, maxTime]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const visiblePoints = useMemo(() => {
    const [start, end] = xDomain;
    const filtered = points.filter((point) => point.time >= start && point.time <= end);
    return filtered.length > 1 ? filtered : points;
  }, [points, xDomain]);
  const visibleSampledPoints = useMemo(() => downsample(visiblePoints), [visiblePoints]);
  const visibleValues = useMemo(() => visiblePoints.map((point) => point.value), [visiblePoints]);
  const [visibleMinValue, visibleMaxValue] = useMemo(() => extent(visibleValues), [visibleValues]);

  const innerWidth = Math.max(size.width - MARGIN.left - MARGIN.right, 180);
  const innerHeight = Math.max(size.height - MARGIN.top - MARGIN.bottom, 220);
  const xScale = useMemo(() => linearScale(xDomain, [MARGIN.left, MARGIN.left + innerWidth]), [xDomain, innerWidth]);
  const yScale = useMemo(
    () => linearScale([visibleMinValue, visibleMaxValue], [MARGIN.top + innerHeight, MARGIN.top]),
    [visibleMinValue, visibleMaxValue, innerHeight],
  );
  const path = useMemo(() => buildLinePath(visibleSampledPoints, xScale, yScale), [visibleSampledPoints, xScale, yScale]);

  const minSpan = useMemo(() => Math.max((maxTime - minTime) / 500, Number.EPSILON), [maxTime, minTime]);
  const interactionMode = activePeak !== null ? "dragging-peak" : panStart ? "panning" : "idle";

  const applyPeakUpdate = (peakOrder: number, nextIndex: number) => {
    setDraftPeaks((current) => {
      if (current[peakOrder] === nextIndex) {
        return current;
      }
      if (current.includes(nextIndex)) {
        return current;
      }
      const next = [...current];
      next[peakOrder] = nextIndex;
      draftRef.current = next;
      return next;
    });
  };

  const flushPendingPeak = () => {
    const pending = pendingPeakRef.current;
    if (!pending) {
      return;
    }
    pendingPeakRef.current = null;
    applyPeakUpdate(pending.peakOrder, pending.index);
  };

  const commitDraft = () => {
    const sorted = [...draftRef.current].sort((left, right) => left - right);
    draftRef.current = sorted;
    setDraftPeaks(sorted);
    onPeakCommit(sorted);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activePeak !== null) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const nextIndex = nearestPointIndex(points, xScale.toDomain(x));
      pendingPeakRef.current = { peakOrder: activePeak, index: nextIndex };
      if (rafRef.current === null) {
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = null;
          flushPendingPeak();
        });
      }
      return;
    }

    if (!panStart) {
      return;
    }

    const [start, end] = panStart.domain;
    const span = end - start;
    const deltaPixels = event.clientX - panStart.clientX;
    const deltaTime = (deltaPixels / innerWidth) * span;
    setXDomain(clampDomain([start - deltaTime, end - deltaTime], minTime, maxTime, minSpan));
  };

  const finishInteraction = () => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    flushPendingPeak();

    const wasDraggingPeak = activePeak !== null;
    setActivePeak(null);
    setPanStart(null);

    if (wasDraggingPeak) {
      commitDraft();
    }
  };

  const handleWheel = useEffectEvent((event: WheelEvent) => {
    event.preventDefault();

    const svg = svgRef.current;
    if (!svg) {
      return;
    }

    const bounds = svg.getBoundingClientRect();
    const cursorX = event.clientX - bounds.left;
    const anchor = xScale.toDomain(cursorX);
    const [start, end] = xDomain;
    const span = end - start;
    const fullSpan = maxTime - minTime;
    const factor = event.deltaY < 0 ? 0.85 : 1.15;
    const nextSpan = Math.min(fullSpan, Math.max(minSpan, span * factor));
    const ratio = span === 0 ? 0.5 : (anchor - start) / span;
    const nextStart = anchor - nextSpan * ratio;
    const nextEnd = nextStart + nextSpan;

    setXDomain(clampDomain([nextStart, nextEnd], minTime, maxTime, minSpan));
  });

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }

    const listener = (event: WheelEvent) => handleWheel(event);
    svg.addEventListener("wheel", listener, { passive: false });
    return () => svg.removeEventListener("wheel", listener);
  }, [handleWheel]);

  return (
    <div className="chart-shell" ref={containerRef}>
      <div className="chart-toolbar">
        <p className="chart-hint">Scroll to zoom. Drag the plot to pan. Drag a red marker to move a peak.</p>
        <button className="toolbar-button" onClick={() => setXDomain([minTime, maxTime])} type="button">
          Reset zoom
        </button>
      </div>
      <svg
        ref={svgRef}
        className={`chart-svg chart-svg-${interactionMode}`}
        viewBox={`0 0 ${size.width} ${size.height}`}
        onPointerMove={onPointerMove}
        onPointerUp={finishInteraction}
        onPointerLeave={finishInteraction}
      >
        <rect x={0} y={0} width={size.width} height={size.height} fill="#fffaf1" rx={18} />
        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={innerWidth}
          height={innerHeight}
          fill="transparent"
          onPointerDown={(event) => {
            if (activePeak !== null) {
              return;
            }
            (event.currentTarget as SVGRectElement).setPointerCapture(event.pointerId);
            setPanStart({ clientX: event.clientX, domain: xDomain });
          }}
          onDoubleClick={() => setXDomain([minTime, maxTime])}
        />
        <path d={path} fill="none" stroke="#19323c" strokeWidth={1.6} />
        <line x1={MARGIN.left} x2={MARGIN.left} y1={MARGIN.top} y2={MARGIN.top + innerHeight} stroke="#8f9ca3" />
        <line
          x1={MARGIN.left}
          x2={MARGIN.left + innerWidth}
          y1={MARGIN.top + innerHeight}
          y2={MARGIN.top + innerHeight}
          stroke="#8f9ca3"
        />
        {draftPeaks.map((peakIndex, peakOrder) => {
          const point = points[peakIndex];
          if (!point || point.time < xDomain[0] || point.time > xDomain[1]) {
            return null;
          }

          return (
            <g key={`${peakOrder}-${peakIndex}`}>
              <circle
                className="chart-peak-handle"
                cx={xScale.toRange(point.time)}
                cy={yScale.toRange(point.value)}
                r={activePeak === peakOrder ? 9 : 8}
                fill="#d94841"
                stroke="#fff"
                strokeWidth={2}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  (event.currentTarget as SVGCircleElement).setPointerCapture(event.pointerId);
                  setPanStart(null);
                  setActivePeak(peakOrder);
                }}
              />
              <text
                x={xScale.toRange(point.time)}
                y={yScale.toRange(point.value) - 14}
                textAnchor="middle"
                className="chart-peak-label"
              >
                {peakOrder + 1}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

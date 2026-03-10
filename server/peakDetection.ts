import type { PeakMode } from "./types.js";

const PEAK_MODES: PeakMode[] = ["max", "min", "both"];

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function movingAverage(values: number[], window: number): number[] {
  if (window <= 1 || values.length === 0) {
    return [...values];
  }

  const result = new Array<number>(values.length).fill(0);
  const prefix = new Array<number>(values.length + 1).fill(0);
  for (let index = 0; index < values.length; index += 1) {
    prefix[index + 1] = prefix[index] + values[index];
  }

  const radius = Math.floor(window / 2);
  for (let index = 0; index < values.length; index += 1) {
    const left = Math.max(0, index - radius);
    const right = Math.min(values.length, index + radius + 1);
    result[index] = (prefix[right] - prefix[left]) / (right - left);
  }

  return result;
}

function localExtrema(values: number[], kind: "max" | "min"): number[] {
  if (values.length === 0) {
    return [];
  }

  const extrema: number[] = [];
  let runStart = 0;

  while (runStart < values.length) {
    let runEnd = runStart;
    while (runEnd + 1 < values.length && values[runEnd + 1] === values[runStart]) {
      runEnd += 1;
    }

    const currentValue = values[runStart];
    const previousValue = runStart > 0 ? values[runStart - 1] : null;
    const nextValue = runEnd + 1 < values.length ? values[runEnd + 1] : null;
    const plateauIndex = Math.floor((runStart + runEnd) / 2);

    const isExtremum =
      kind === "max"
        ? (previousValue === null || currentValue > previousValue) && (nextValue === null || currentValue > nextValue)
        : (previousValue === null || currentValue < previousValue) && (nextValue === null || currentValue < nextValue);

    if (isExtremum) {
      extrema.push(plateauIndex);
    }

    runStart = runEnd + 1;
  }

  if (extrema.length === values.length && values.every((value) => value === values[0])) {
    return [Math.floor((values.length - 1) / 2)];
  }

  return extrema;
}

function localMaxima(values: number[]): number[] {
  return localExtrema(values, "max");
}

function localMinima(values: number[]): number[] {
  return localExtrema(values, "min");
}

function greedySelect(candidates: number[], scores: number[], minDistance: number): number[] {
  const ordered = [...candidates].sort((left, right) => scores[right] - scores[left]);
  const selected: number[] = [];

  for (const candidate of ordered) {
    if (selected.every((chosen) => Math.abs(candidate - chosen) >= minDistance)) {
      selected.push(candidate);
    }
  }

  return selected;
}

function windowFallback(values: number[], count: number): number[] {
  const usable: number[] = [];
  values.forEach((value, index) => {
    if (isFiniteNumber(value)) {
      usable.push(index);
    }
  });

  if (usable.length === 0) {
    return [];
  }

  const start = usable[0];
  const stop = usable[usable.length - 1] + 1;
  const chosen: number[] = [];

  for (let bucket = 0; bucket < count; bucket += 1) {
    const left = Math.floor(start + ((stop - start) * bucket) / count);
    const right = Math.max(left + 1, Math.floor(start + ((stop - start) * (bucket + 1)) / count));
    let bestIndex = left;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = left; index < Math.min(right, values.length); index += 1) {
      if (values[index] > bestValue) {
        bestValue = values[index];
        bestIndex = index;
      }
    }
    chosen.push(bestIndex);
  }

  return chosen;
}

function median(values: number[]): number {
  const sorted = values.filter(isFiniteNumber).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function snapToExtremum(
  signal: number[],
  baseline: number,
  index: number,
  peakMode: PeakMode,
  radius: number,
): number {
  const left = Math.max(0, index - radius);
  const right = Math.min(signal.length, index + radius + 1);
  if (right <= left) {
    return index;
  }

  const localWindow = signal.slice(left, right);
  const extrema =
    peakMode === "max"
      ? localMaxima(localWindow)
      : peakMode === "min"
        ? localMinima(localWindow)
        : [...new Set([...localMaxima(localWindow), ...localMinima(localWindow)])].sort((a, b) => a - b);
  const candidates = extrema.map((candidate) => candidate + left);
  if (candidates.length === 0) {
    return index;
  }

  let bestIndex = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const cursor of candidates) {
    const value = signal[cursor];
    const score =
      peakMode === "min"
        ? -value
        : peakMode === "both"
          ? Math.abs(value - baseline)
          : value;

    if (score > bestScore || (score === bestScore && Math.abs(cursor - index) < Math.abs(bestIndex - index))) {
      bestScore = score;
      bestIndex = cursor;
    }
  }

  return bestIndex;
}

export function applyMultiplier(values: number[], multiplyBy: number): number[] {
  return values.map((value) => value * multiplyBy);
}

export function selectPeakIndices(values: number[], peakCount: number, peakMode: PeakMode): number[] {
  if (!PEAK_MODES.includes(peakMode)) {
    throw new Error(`Unsupported peak mode: ${peakMode}`);
  }

  const signal = [...values];
  const finiteValues = signal.filter(isFiniteNumber);
  if (finiteValues.length === 0 || peakCount <= 0) {
    return [];
  }

  const baseline = median(finiteValues);
  const filled = signal.map((value) => (isFiniteNumber(value) ? value : baseline));
  const centered = filled.map((value) => value - baseline);
  const window = Math.max(5, Math.min(31, Math.floor(filled.length / Math.max(peakCount * 100, 1)) * 2 + 1));
  const smoothed = movingAverage(centered, window);
  const snapRadius = Math.max(1, Math.floor(window / 2));

  const candidateScores =
    peakMode === "max"
      ? smoothed.map((value) => Math.max(value, 0))
      : peakMode === "min"
        ? smoothed.map((value) => Math.max(-value, 0))
        : smoothed.map((value) => Math.abs(value));

  const initialCandidates =
    peakMode === "max"
      ? localMaxima(smoothed)
      : peakMode === "min"
        ? localMinima(smoothed)
        : [...new Set([...localMaxima(smoothed), ...localMinima(smoothed)])].sort((a, b) => a - b);

  const scoredCandidates = new Map<number, number>();
  for (const candidate of initialCandidates) {
    const candidateScore = candidateScores[candidate];
    if (candidateScore <= 0) {
      continue;
    }

    const snapped = snapToExtremum(filled, baseline, candidate, peakMode, snapRadius);
    const snappedScore = Math.abs(filled[snapped] - baseline);

    if (peakMode === "max" && filled[snapped] < baseline) {
      continue;
    }
    if (peakMode === "min" && filled[snapped] > baseline) {
      continue;
    }

    const previous = scoredCandidates.get(snapped) ?? Number.NEGATIVE_INFINITY;
    if (snappedScore > previous) {
      scoredCandidates.set(snapped, snappedScore);
    }
  }

  let chosen: number[] = [];
  if (scoredCandidates.size > 0) {
    const candidates = [...scoredCandidates.keys()].sort((left, right) => left - right);
    const scores = new Array<number>(filled.length).fill(0);
    for (const [index, score] of scoredCandidates.entries()) {
      scores[index] = score;
    }
    chosen = greedySelect(candidates, scores, Math.max(1, snapRadius)).slice(0, peakCount);
  }

  if (chosen.length < peakCount) {
    const fallbackValues =
      peakMode === "both"
        ? centered.map((value) => Math.abs(value))
        : peakMode === "min"
          ? centered.map((value) => Math.max(-value, 0))
          : centered.map((value) => Math.max(value, 0));

    const seen = new Set(chosen);
    for (const index of windowFallback(fallbackValues, peakCount)) {
      if (!seen.has(index) && fallbackValues[index] > 0) {
        chosen.push(index);
        seen.add(index);
      }
      if (chosen.length === peakCount) {
        break;
      }
    }
  }

  if (chosen.length < peakCount) {
    const order = [...filled.keys()].sort((left, right) => {
      if (peakMode === "min") {
        return centered[left] - centered[right];
      }
      if (peakMode === "both") {
        return Math.abs(centered[right]) - Math.abs(centered[left]);
      }
      return centered[right] - centered[left];
    });

    const seen = new Set(chosen);
    for (const index of order) {
      if (seen.has(index)) {
        continue;
      }
      if (peakMode === "max" && centered[index] <= 0) {
        continue;
      }
      if (peakMode === "min" && centered[index] >= 0) {
        continue;
      }
      chosen.push(index);
      seen.add(index);
      if (chosen.length === peakCount) {
        break;
      }
    }
  }

  return chosen.slice(0, peakCount).sort((left, right) => left - right);
}

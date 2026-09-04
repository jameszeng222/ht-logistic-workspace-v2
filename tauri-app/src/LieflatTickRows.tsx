import type { CSSProperties, KeyboardEvent } from "react";

export interface LieflatTickRow {
  label: string;
  value: number;
  detail?: string;
  highlight?: boolean;
}

interface Props {
  rows: LieflatTickRow[];
  formatValue: (value: number) => string;
  unitLabel: (unit: number) => string;
  onSelect?: (row: LieflatTickRow) => void;
  emptyLabel?: string;
}

const NICE_STEPS = [1, 2, 2.5, 5, 10];

function niceUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const normalized = value / power;
  const step = NICE_STEPS.find((candidate) => candidate >= normalized) || 10;
  return step * power;
}

function variance(rowIndex: number, tickIndex: number): number {
  const seed = Math.sin((rowIndex + 1) * 91.37 + (tickIndex + 1) * 47.11) * 10000;
  return seed - Math.floor(seed);
}

function shortLabel(value: string): string {
  return value.length > 12 ? `${value.slice(0, 11)}…` : value;
}

export function LieflatTickRows({ rows, formatValue, unitLabel, onSelect, emptyLabel = "暂无可比较数据" }: Props) {
  const visibleRows = rows.filter((row) => Number.isFinite(row.value) && row.value >= 0).slice(0, 8);
  if (!visibleRows.length) return <div className="lf-tick-empty">{emptyLabel}</div>;

  const maximum = Math.max(...visibleRows.map((row) => row.value), 0);
  const unit = niceUnit(maximum / 30);
  const maximumTicks = Math.max(1, Math.ceil(maximum / unit));
  const width = 640;
  const labelWidth = 132;
  const valueWidth = 98;
  const plotWidth = width - labelWidth - valueWidth - 28;
  const spacing = plotWidth / maximumTicks;
  const rowHeight = 42;
  const top = 22;
  const height = top + visibleRows.length * rowHeight + 28;

  const activate = (event: KeyboardEvent<SVGGElement>, row: LieflatTickRow) => {
    if (!onSelect || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onSelect(row);
  };

  return <div className="lf-tick-rows">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`横向刻度比较图，每个刻度约 ${unitLabel(unit)}`}>
      {visibleRows.map((row, rowIndex) => {
        const y = top + rowIndex * rowHeight;
        const tickCount = Math.max(row.value > 0 ? 1 : 0, Math.round(row.value / unit));
        const colorClass = row.highlight ? "is-highlight" : "";
        return <g
          key={`${row.label}-${rowIndex}`}
          className={`lf-tick-row ${colorClass} ${onSelect ? "is-actionable" : ""}`}
          role={onSelect ? "button" : undefined}
          tabIndex={onSelect ? 0 : undefined}
          aria-label={`${row.label}，${formatValue(row.value)}${row.detail ? `，${row.detail}` : ""}`}
          onClick={onSelect ? () => onSelect(row) : undefined}
          onKeyDown={(event) => activate(event, row)}
        >
          <text x={labelWidth - 12} y={y + 4} textAnchor="end" className="lf-tick-label">{shortLabel(row.label)}</text>
          <line x1={labelWidth} y1={y + 10} x2={labelWidth + plotWidth} y2={y + 10} className="lf-tick-guide" />
          {Array.from({ length: tickCount }, (_, tickIndex) => {
            const jitter = variance(rowIndex, tickIndex);
            const x = labelWidth + tickIndex * spacing + spacing / 2;
            const tickHeight = 11 + jitter * 7;
            const style = { "--tick-delay": `${rowIndex * 48 + tickIndex * 9}ms` } as CSSProperties;
            return <g key={tickIndex}>
              <line
                x1={x}
                y1={y + 10}
                x2={x}
                y2={y + 10 - tickHeight}
                className="lf-tick-mark"
                style={style}
              />
              {(tickIndex + 1) % 5 === 0 && <circle cx={x} cy={y + 15} r="1.25" className="lf-tick-five" />}
            </g>;
          })}
          <text x={labelWidth + plotWidth + 12} y={y + 4} className="lf-tick-value">{formatValue(row.value)}</text>
          {row.detail && <text x={labelWidth + plotWidth + 12} y={y + 17} className="lf-tick-detail">{row.detail}</text>}
        </g>;
      })}
      <text x={labelWidth} y={height - 6} className="lf-tick-source">一条竖线约等于 {unitLabel(unit)} · 圆点标记每五格 · 精确值见行尾</text>
    </svg>
  </div>;
}

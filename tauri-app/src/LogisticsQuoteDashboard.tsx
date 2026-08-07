import { useMemo, useState } from "react";
import { AlertTriangle, Bot, Boxes, CircleDollarSign, FileWarning, Scale, Truck } from "lucide-react";

export interface LogisticsQuoteRecord {
  pickupDate: string | null;
  order: string;
  origin: string;
  destination: string;
  transport: string;
  channel: string;
  provider: string;
  category: string;
  product: string;
  unitPrice: number | null;
  unitPriceText: string;
  billingWeight: number | null;
  freight: number | null;
  customsFee: number | null;
  insuranceFee: number | null;
  miscFee: number | null;
  duty: number | null;
  surcharge: number | null;
  deduction: number | null;
  total: number | null;
  boxes: number | null;
  pieces: number | null;
  customsDeclared: string;
  hasComplexRate: boolean;
  missingAmount: boolean;
}

export interface LogisticsQuoteReport {
  sourceName: string;
  updatedAt: string;
  rows: number;
  columnCount: number;
  records: LogisticsQuoteRecord[];
}

interface Props {
  report: LogisticsQuoteReport;
  onSendToAssistant: (message: string) => void;
}

type View = "overview" | "rates" | "quality";
type FilterKey = "provider" | "transport" | "channel" | "origin" | "destination";

const EMPTY_FILTERS: Record<FilterKey, string> & { month: string; dateFrom: string; dateTo: string } = {
  month: "全部", dateFrom: "", dateTo: "", provider: "全部", transport: "全部", channel: "全部", origin: "全部", destination: "全部",
};
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 });

function options(records: LogisticsQuoteRecord[], key: FilterKey): string[] {
  return [...new Set(records.map((record) => record[key]).filter((value) => value && value !== "未填写"))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function amountLabel(value: number): string {
  return value > 0 ? money.format(value) : "—";
}

export function LogisticsQuoteDashboard({ report, onSendToAssistant }: Props) {
  const [view, setView] = useState<View>("overview");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const months = useMemo(() => [...new Set(report.records.map((record) => record.pickupDate?.slice(0, 7)).filter(Boolean) as string[])].sort().reverse(), [report.records]);
  const filtered = useMemo(() => report.records.filter((record) => {
    if (filters.month !== "全部" && record.pickupDate?.slice(0, 7) !== filters.month) return false;
    if (filters.dateFrom && (!record.pickupDate || record.pickupDate < filters.dateFrom)) return false;
    if (filters.dateTo && (!record.pickupDate || record.pickupDate > filters.dateTo)) return false;
    return (["provider", "transport", "channel", "origin", "destination"] as FilterKey[]).every((key) => filters[key] === "全部" || record[key] === filters[key]);
  }), [filters, report.records]);
  const activeFilters = Object.entries(filters).filter(([key, value]) => value !== EMPTY_FILTERS[key as keyof typeof EMPTY_FILTERS]).length;
  const orders = new Set(filtered.map((record) => record.order).filter(Boolean)).size;
  const totalAmount = filtered.reduce((sum, record) => sum + (record.total || 0), 0);
  const totalWeight = filtered.reduce((sum, record) => sum + (record.billingWeight || 0), 0);
  const totalBoxes = filtered.reduce((sum, record) => sum + (record.boxes || 0), 0);
  const validRates = filtered.filter((record) => record.unitPrice !== null);
  const averageRate = validRates.length ? validRates.reduce((sum, record) => sum + (record.unitPrice || 0), 0) / validRates.length : 0;

  const providerRows = useMemo(() => {
    const groups = new Map<string, { name: string; records: number; amount: number; rates: number[]; weight: number }>();
    filtered.forEach((record) => {
      const row = groups.get(record.provider) || { name: record.provider, records: 0, amount: 0, rates: [], weight: 0 };
      row.records += 1;
      row.amount += record.total || 0;
      row.weight += record.billingWeight || 0;
      if (record.unitPrice !== null) row.rates.push(record.unitPrice);
      groups.set(record.provider, row);
    });
    return [...groups.values()].map((row) => ({ ...row, averageRate: row.rates.length ? row.rates.reduce((sum, value) => sum + value, 0) / row.rates.length : 0 })).sort((a, b) => b.amount - a.amount || b.records - a.records);
  }, [filtered]);

  const routeRows = useMemo(() => {
    const groups = new Map<string, { route: string; transport: string; records: number; providers: Set<string>; rates: number[] }>();
    filtered.forEach((record) => {
      const route = `${record.origin} → ${record.destination}`;
      const key = `${route}|${record.transport}`;
      const row = groups.get(key) || { route, transport: record.transport, records: 0, providers: new Set<string>(), rates: [] };
      row.records += 1;
      row.providers.add(record.provider);
      if (record.unitPrice !== null) row.rates.push(record.unitPrice);
      groups.set(key, row);
    });
    return [...groups.values()].map((row) => ({
      ...row,
      providerCount: row.providers.size,
      minRate: row.rates.length ? Math.min(...row.rates) : 0,
      maxRate: row.rates.length ? Math.max(...row.rates) : 0,
      averageRate: row.rates.length ? row.rates.reduce((sum, value) => sum + value, 0) / row.rates.length : 0,
    })).sort((a, b) => b.records - a.records);
  }, [filtered]);

  const complexRates = filtered.filter((record) => record.hasComplexRate).length;
  const missingWeights = filtered.filter((record) => record.billingWeight === null).length;
  const missingAmounts = filtered.filter((record) => record.missingAmount).length;
  const sendToAi = () => onSendToAssistant([
    "请根据下面的物流报价看板，分析线路价格、物流商差异、费用异常和可优化的采购动作。",
    `数据源：${report.sourceName}；筛选后 ${filtered.length} 条，${orders} 个调拨单。`,
    `记录总金额 ${amountLabel(totalAmount)}，计费重 ${number.format(totalWeight)}，平均可识别单价 ${averageRate ? money.format(averageRate) : "暂无"}。`,
    `复杂报价 ${complexRates} 条，缺计费重 ${missingWeights} 条，缺运费/总金额 ${missingAmounts} 条。`,
    `主要物流商：${providerRows.slice(0, 5).map((row) => `${row.name} ${row.records}条，金额${amountLabel(row.amount)}`).join("；") || "暂无"}`,
  ].join("\n\n"));

  return <div className="ct-shell lq-shell">
    <div className="ct-tabs">
      {(["overview", "rates", "quality"] as View[]).map((key) => <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>{{ overview: "报价总览", rates: "线路报价", quality: "数据复核" }[key]}</button>)}
      <span className="ct-tabs-spacer" />
      <button className="ct-ai-action" onClick={sendToAi}><Bot size={14} />交给 AI 分析</button>
    </div>

    <div className="ct-filters">
      <div className="ct-period-row">
        <div className="ct-months">{["全部", ...months].map((month) => <button key={month} className={filters.month === month ? "active" : ""} onClick={() => setFilters((current) => ({ ...current, month, dateFrom: "", dateTo: "" }))}>{month === "全部" ? "全部月份" : month.replace("-", "/")}</button>)}</div>
        <div className="ct-date-range"><b>提货日期</b><label><span>开始</span><input type="date" value={filters.dateFrom} max={filters.dateTo || undefined} onChange={(event) => setFilters((current) => ({ ...current, month: "全部", dateFrom: event.target.value }))} /></label><i>至</i><label><span>结束</span><input type="date" value={filters.dateTo} min={filters.dateFrom || undefined} onChange={(event) => setFilters((current) => ({ ...current, month: "全部", dateTo: event.target.value }))} /></label></div>
      </div>
      <div className="ct-filter-row lq-filter-row">
        {(["provider", "transport", "channel", "origin", "destination"] as FilterKey[]).map((key) => <label key={key}><span>{{ provider: "物流商", transport: "运输方式", channel: "物流渠道", origin: "发货地", destination: "目的地" }[key]}</span><select value={filters[key]} onChange={(event) => setFilters((current) => ({ ...current, [key]: event.target.value }))}><option>全部</option>{options(report.records, key).map((value) => <option key={value}>{value}</option>)}</select></label>)}
        <button className="ct-reset" disabled={!activeFilters} onClick={() => setFilters(EMPTY_FILTERS)}>重置{activeFilters ? ` ${activeFilters}` : ""}</button>
      </div>
    </div>

    <div className="ct-scroll">
      <section className="ct-kpis">
        <article><span><CircleDollarSign size={15} />记录总金额</span><strong>{amountLabel(totalAmount)}</strong><small>{number.format(filtered.length)} 条报价记录</small></article>
        <article><span><Truck size={15} />运输批次</span><strong>{number.format(orders)}</strong><small>{number.format(providerRows.length)} 家物流商</small></article>
        <article><span><Scale size={15} />计费重量</span><strong>{totalWeight ? number.format(totalWeight) : "—"}</strong><small>{number.format(totalBoxes)} 箱</small></article>
        <article className={complexRates ? "warning" : ""}><span><AlertTriangle size={15} />平均单价</span><strong>{averageRate ? money.format(averageRate) : "—"}</strong><small>{complexRates} 条复杂报价待复核</small></article>
      </section>

      {view === "overview" && <div className="ct-overview-grid">
        <section className="ct-panel"><header><div><small>CARRIER COST</small><h2>物流商报价分布</h2></div><span>TOP 8</span></header><div className="ct-provider-bars">{providerRows.slice(0, 8).map((row) => { const basis = totalAmount > 0 ? row.amount : row.records; const total = totalAmount > 0 ? totalAmount : filtered.length; return <button key={row.name} onClick={() => setFilters((current) => ({ ...current, provider: row.name }))}><span>{row.name}</span><i><b style={{ width: `${total ? basis / total * 100 : 0}%` }} /></i><strong>{totalAmount > 0 ? amountLabel(row.amount) : `${row.records} 条`}</strong></button>; })}</div></section>
        <section className="ct-panel"><header><div><small>ROUTE COVERAGE</small><h2>常用线路</h2></div><span>按记录数</span></header><div className="lq-route-list">{routeRows.slice(0, 8).map((row) => <article key={`${row.route}-${row.transport}`}><span><strong>{row.route}</strong><small>{row.transport} · {row.providerCount} 家物流商</small></span><b>{row.records} 条</b></article>)}</div></section>
      </div>}

      {view === "rates" && <section className="ct-panel ct-table-panel"><header><div><small>ROUTE RATE BOOK</small><h2>线路价格对比</h2></div><span>{routeRows.length} 条线路</span></header><div className="ct-table-scroll"><table><thead><tr><th>线路</th><th>运输方式</th><th>物流商数</th><th>记录数</th><th>最低单价</th><th>平均单价</th><th>最高单价</th></tr></thead><tbody>{routeRows.map((row) => <tr key={`${row.route}-${row.transport}`}><td><strong>{row.route}</strong></td><td>{row.transport}</td><td>{row.providerCount}</td><td>{row.records}</td><td>{row.minRate ? money.format(row.minRate) : "—"}</td><td>{row.averageRate ? money.format(row.averageRate) : "—"}</td><td>{row.maxRate ? money.format(row.maxRate) : "—"}</td></tr>)}</tbody></table></div></section>}

      {view === "quality" && <>
        <div className="ct-quality-grid">
          <section className="ct-panel"><header><div><small>DATA QUALITY</small><h2>报价可用性</h2></div></header><div className="ct-quality-score"><strong>{report.columnCount}</strong><span>源表字段</span><strong>{number.format(filtered.length)}</strong><span>筛选记录</span><strong>{number.format(validRates.length)}</strong><span>可计算单价</span></div></section>
          <section className="ct-panel"><header><div><small>REVIEW QUEUE</small><h2>需要复核</h2></div></header><div className="ct-quality-list"><span><FileWarning size={15} />复杂单价表达式 <b>{complexRates}</b></span><span><Scale size={15} />缺少计费重量 <b>{missingWeights}</b></span><span><CircleDollarSign size={15} />缺少运费与总金额 <b>{missingAmounts}</b></span></div></section>
        </div>
        <section className="ct-panel ct-table-panel lq-records"><header><div><small>QUOTE RECORDS</small><h2>报价记录</h2></div><span>显示前 200 条</span></header><div className="ct-table-scroll"><table><thead><tr><th>提货日期</th><th>调拨单</th><th>线路</th><th>运输 / 渠道</th><th>物流商</th><th>单价原文</th><th>计费重</th><th>总金额</th></tr></thead><tbody>{filtered.slice(0, 200).map((record, index) => <tr key={`${record.order}-${index}`}><td>{record.pickupDate || "—"}</td><td><strong>{record.order || "—"}</strong></td><td>{record.origin} → {record.destination}</td><td>{record.transport}<small>{record.channel}</small></td><td>{record.provider}</td><td><span className={record.hasComplexRate ? "lq-review-rate" : ""}>{record.unitPriceText || "—"}</span></td><td>{record.billingWeight === null ? "—" : number.format(record.billingWeight)}</td><td>{record.total === null ? "—" : money.format(record.total)}</td></tr>)}</tbody></table></div></section>
      </>}
    </div>
  </div>;
}

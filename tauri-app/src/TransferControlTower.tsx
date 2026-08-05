import { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Bot, Boxes, CheckCircle2, ClipboardList, PackageCheck, Truck } from "lucide-react";

export interface TransferRecord {
  pickupDate: string | null;
  order: string;
  box: string;
  team: string;
  category: string;
  origin: string;
  provider: string;
  channel: string;
  transport: string;
  lastMile: string;
  destination: string;
  status: string;
  requirement: number | null;
  duration: number | null;
  ontime: boolean | null;
  anomaly: boolean;
  logisticsException: string;
  shelfException: string;
  verification: string;
  description: string;
  receiptDate: string | null;
  shelfDate: string | null;
  expectedReceiptDate: string | null;
  expectedShelfDate: string | null;
  overdueUnreceived: boolean;
  overdueUnshelved: boolean;
  overdueDays: number;
  trackingMissing: boolean;
}

export interface TransferControlTowerReport {
  sourceName: string;
  updatedAt: string;
  rows: number;
  columnCount: number;
  invalidDurationCount: number;
  records: TransferRecord[];
}

interface Props {
  report: TransferControlTowerReport;
  onSendToAssistant: (message: string) => void;
}

type View = "overview" | "exceptions" | "providers" | "quality";
type Filters = { month: string; dateFrom: string; dateTo: string; category: string; team: string; provider: string; transport: string; origin: string; destination: string };
const EMPTY_FILTERS: Filters = { month: "全部", dateFrom: "", dateTo: "", category: "全部", team: "全部", provider: "全部", transport: "全部", origin: "全部", destination: "全部" };
const FILTER_LABELS: Record<keyof Filters, string> = { month: "月份", dateFrom: "开始日期", dateTo: "结束日期", category: "一级分类", team: "团队", provider: "物流商", transport: "运输方式", origin: "发货仓", destination: "接收仓" };
const number = new Intl.NumberFormat("zh-CN");
const percent = (value: number, total: number) => total ? `${(value / total * 100).toFixed(1)}%` : "—";

function options(records: TransferRecord[], key: keyof TransferRecord) {
  return [...new Set(records.map((record) => String(record[key] ?? "未填写")))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function issue(record: TransferRecord) {
  if (record.overdueUnreceived) return `超期未签收 ${record.overdueDays} 天`;
  if (record.overdueUnshelved) return `超期未上架 ${record.overdueDays} 天`;
  if (record.trackingMissing) return "缺少物流跟踪号";
  if (record.logisticsException !== "无异常" && record.logisticsException !== "未填写") return record.logisticsException;
  if (record.shelfException !== "无异常" && record.shelfException !== "未填写") return record.shelfException;
  return "综合异常";
}

export function TransferControlTower({ report, onSendToAssistant }: Props) {
  const [view, setView] = useState<View>("overview");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const months = useMemo(() => [...new Set(report.records.map((record) => record.pickupDate?.slice(0, 7)).filter(Boolean) as string[])].sort(), [report.records]);
  const filtered = useMemo(() => report.records.filter((record) => (
    (filters.month === "全部" || record.pickupDate?.slice(0, 7) === filters.month)
    && (!filters.dateFrom || Boolean(record.pickupDate && record.pickupDate >= filters.dateFrom))
    && (!filters.dateTo || Boolean(record.pickupDate && record.pickupDate <= filters.dateTo))
    && (filters.category === "全部" || record.category === filters.category)
    && (filters.team === "全部" || record.team === filters.team)
    && (filters.provider === "全部" || record.provider === filters.provider)
    && (filters.transport === "全部" || record.transport === filters.transport)
    && (filters.origin === "全部" || record.origin === filters.origin)
    && (filters.destination === "全部" || record.destination === filters.destination)
  )), [filters, report.records]);

  const completed = filtered.filter((record) => record.ontime !== null);
  const ontime = completed.filter((record) => record.ontime).length;
  const anomaly = filtered.filter((record) => record.anomaly).length;
  const signed = filtered.filter((record) => record.receiptDate).length;
  const shelved = filtered.filter((record) => record.shelfDate).length;
  const overdueReceipt = filtered.filter((record) => record.overdueUnreceived).length;
  const overdueShelf = filtered.filter((record) => record.overdueUnshelved).length;
  const missingTracking = filtered.filter((record) => record.trackingMissing).length;
  const orders = new Set(filtered.map((record) => record.order).filter(Boolean)).size;
  const activeFilters = Object.entries(filters).filter(([key, value]) => value !== EMPTY_FILTERS[key as keyof Filters]).length;

  const providerRows = useMemo(() => {
    const groups = new Map<string, { name: string; boxes: number; completed: number; ontime: number; anomaly: number; duration: number; durationCount: number }>();
    filtered.forEach((record) => {
      const row = groups.get(record.provider) || { name: record.provider, boxes: 0, completed: 0, ontime: 0, anomaly: 0, duration: 0, durationCount: 0 };
      row.boxes += 1;
      row.anomaly += Number(record.anomaly);
      if (record.ontime !== null) { row.completed += 1; row.ontime += Number(record.ontime); }
      if (record.duration !== null) { row.duration += record.duration; row.durationCount += 1; }
      groups.set(record.provider, row);
    });
    return [...groups.values()].sort((a, b) => b.boxes - a.boxes);
  }, [filtered]);

  const exceptionRows = useMemo(() => filtered
    .filter((record) => record.anomaly || record.overdueUnreceived || record.overdueUnshelved || record.trackingMissing)
    .sort((a, b) => b.overdueDays - a.overdueDays || Number(b.anomaly) - Number(a.anomaly))
    .slice(0, 100), [filtered]);

  const stages = [
    ["总箱数", filtered.length], ["已签收", signed], ["已上架", shelved],
  ] as Array<[string, number]>;
  const sendToAi = () => {
    const topProviders = providerRows.slice(0, 5).map((row) => `${row.name} ${row.boxes}箱，准交率${percent(row.ontime, row.completed)}，异常率${percent(row.anomaly, row.boxes)}`).join("；");
    onSendToAssistant([
      "请根据下面的调拨时效看板结果，判断主要风险、物流商表现和本周应优先处理的事项。",
      `筛选范围：${Object.entries(filters).filter(([key, value]) => value !== EMPTY_FILTERS[key as keyof Filters]).map(([key, value]) => `${FILTER_LABELS[key as keyof Filters]}=${value}`).join("，") || "全部数据"}`,
      `共 ${filtered.length} 箱、${orders} 个调拨单，签收准交率 ${percent(ontime, completed.length)}，异常率 ${percent(anomaly, filtered.length)}。`,
      `超期未签收 ${overdueReceipt} 箱，超期未上架 ${overdueShelf} 箱，缺少跟踪号 ${missingTracking} 箱。`,
      `物流商：${topProviders || "暂无"}`,
    ].join("\n\n"));
  };

  return (
    <div className="ct-shell">
      <div className="ct-tabs">
        {(["overview", "exceptions", "providers", "quality"] as View[]).map((key) => (
          <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
            {{ overview: "经营总览", exceptions: "异常待办", providers: "物流商绩效", quality: "数据质量" }[key]}
            {key === "exceptions" && exceptionRows.length > 0 && <b>{exceptionRows.length}</b>}
          </button>
        ))}
        <span className="ct-tabs-spacer" />
        <button className="ct-ai-action" onClick={sendToAi}><Bot size={14} />交给 AI 分析</button>
      </div>

      <div className="ct-filters">
        <div className="ct-period-row">
          <div className="ct-months">
            {["全部", ...months].map((month) => <button key={month} className={filters.month === month ? "active" : ""} onClick={() => setFilters((current) => ({ ...current, month, dateFrom: "", dateTo: "" }))}>{month === "全部" ? "全部月份" : month.replace("-", "/")}</button>)}
          </div>
          <div className="ct-date-range">
            <b>提货日期</b>
            <label><span>开始</span><input type="date" value={filters.dateFrom} max={filters.dateTo || undefined} onChange={(event) => setFilters((current) => ({ ...current, month: "全部", dateFrom: event.target.value }))} /></label>
            <i>至</i>
            <label><span>结束</span><input type="date" value={filters.dateTo} min={filters.dateFrom || undefined} onChange={(event) => setFilters((current) => ({ ...current, month: "全部", dateTo: event.target.value }))} /></label>
          </div>
        </div>
        <div className="ct-filter-row">
          {(["category", "team", "provider", "transport", "origin", "destination"] as const).map((key) => (
            <label key={key}><span>{{ category: "一级分类", team: "团队", provider: "物流商", transport: "运输方式", origin: "发货仓", destination: "接收仓" }[key]}</span>
              <select value={filters[key]} onChange={(event) => setFilters((current) => ({ ...current, [key]: event.target.value }))}>
                <option>全部</option>{options(report.records, key).map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
          ))}
          <button className="ct-reset" disabled={!activeFilters} onClick={() => setFilters(EMPTY_FILTERS)}>重置{activeFilters ? ` ${activeFilters}` : ""}</button>
        </div>
      </div>

      <div className="ct-scroll">
        <section className="ct-kpis">
          <article><span><Boxes size={15} />调拨箱数</span><strong>{number.format(filtered.length)}</strong><small>{number.format(orders)} 个调拨单</small></article>
          <article><span><PackageCheck size={15} />签收准交率</span><strong>{percent(ontime, completed.length)}</strong><small>{number.format(completed.length)} 箱可计算</small></article>
          <article><span><CheckCircle2 size={15} />签收进度</span><strong>{percent(signed, filtered.length)}</strong><small>{number.format(signed)} 箱已签收</small></article>
          <article className="warning"><span><AlertTriangle size={15} />综合异常率</span><strong>{percent(anomaly, filtered.length)}</strong><small>{number.format(anomaly)} 箱异常</small></article>
        </section>

        {view === "overview" && <>
          <div className="ct-overview-grid">
            <section className="ct-panel">
              <header><div><small>FLOW STATUS</small><h2>履约进度</h2></div><span>箱维度</span></header>
              <div className="ct-stage-list">{stages.map(([label, value]) => <div key={label}><span>{label}</span><i><b style={{ width: `${filtered.length ? value / filtered.length * 100 : 0}%` }} /></i><strong>{number.format(value)}</strong></div>)}</div>
              <div className="ct-risk-strip"><span><b>{number.format(overdueReceipt)}</b> 超期未签收</span><span><b>{number.format(overdueShelf)}</b> 超期未上架</span><span><b>{number.format(missingTracking)}</b> 缺跟踪号</span></div>
            </section>
            <section className="ct-panel">
              <header><div><small>CARRIER SHARE</small><h2>物流商箱量占比</h2></div><span>TOP 6</span></header>
              <div className="ct-provider-bars">{providerRows.slice(0, 6).map((row) => <button key={row.name} onClick={() => setFilters((current) => ({ ...current, provider: row.name }))}><span>{row.name}</span><i><b style={{ width: `${filtered.length ? row.boxes / filtered.length * 100 : 0}%` }} /></i><strong>{percent(row.boxes, filtered.length)}</strong></button>)}</div>
            </section>
          </div>
          <section className="ct-panel ct-priority">
            <header><div><small>ACTION QUEUE</small><h2>优先处理</h2></div><button onClick={() => setView("exceptions")}>查看全部 <ArrowRight size={13} /></button></header>
            <div className="ct-priority-grid">
              {exceptionRows.slice(0, 4).map((record) => <article key={`${record.order}-${record.box}`}><span className={record.overdueDays > 5 ? "high" : ""}>{record.overdueDays > 5 ? "紧急" : "关注"}</span><div><strong>{record.order} · {record.box}</strong><small>{issue(record)}</small></div><em>{record.provider}</em></article>)}
              {!exceptionRows.length && <div className="ct-empty"><CheckCircle2 size={18} />当前筛选范围没有待处理异常</div>}
            </div>
          </section>
        </>}

        {view === "exceptions" && <section className="ct-panel ct-table-panel">
          <header><div><small>EXCEPTION CONTROL</small><h2>异常处理清单</h2></div><span>显示前 {exceptionRows.length} 条</span></header>
          <div className="ct-table-scroll"><table><thead><tr><th>优先级</th><th>调拨单 / 箱号</th><th>问题</th><th>物流商</th><th>接收仓</th><th>当前节点</th><th>核实状态</th></tr></thead><tbody>
            {exceptionRows.map((record) => <tr key={`${record.order}-${record.box}`}><td><span className={`ct-priority-tag ${record.overdueDays > 5 ? "high" : ""}`}>{record.overdueDays > 5 ? "紧急" : "关注"}</span></td><td><strong>{record.order}</strong><small>{record.box}</small></td><td>{issue(record)}</td><td>{record.provider}</td><td>{record.destination}</td><td>{record.status}</td><td>{record.verification}</td></tr>)}
          </tbody></table></div>
        </section>}

        {view === "providers" && <section className="ct-panel ct-table-panel">
          <header><div><small>CARRIER PERFORMANCE</small><h2>物流商量效表现</h2></div><span>{providerRows.length} 家物流商</span></header>
          <div className="ct-table-scroll"><table><thead><tr><th>物流商</th><th>承运箱数</th><th>箱量占比</th><th>已完成</th><th>准交率</th><th>异常率</th><th>平均时效</th></tr></thead><tbody>
            {providerRows.map((row) => <tr key={row.name} onClick={() => setFilters((current) => ({ ...current, provider: row.name }))}><td><strong>{row.name}</strong></td><td>{number.format(row.boxes)}</td><td>{percent(row.boxes, filtered.length)}</td><td>{number.format(row.completed)}</td><td>{percent(row.ontime, row.completed)}</td><td>{percent(row.anomaly, row.boxes)}</td><td>{row.durationCount ? `${(row.duration / row.durationCount).toFixed(1)} 天` : "—"}</td></tr>)}
          </tbody></table></div>
        </section>}

        {view === "quality" && <div className="ct-quality-grid">
          <section className="ct-panel"><header><div><small>DATA QUALITY</small><h2>数据可用性</h2></div></header><div className="ct-quality-score"><strong>{report.columnCount}</strong><span>源表字段</span><strong>{number.format(report.rows)}</strong><span>有效记录</span><strong>{number.format(report.invalidDurationCount)}</strong><span>无效时效值</span></div></section>
          <section className="ct-panel"><header><div><small>FIELD CHECK</small><h2>关键字段检查</h2></div></header><div className="ct-quality-list"><span><ClipboardList size={15} />缺少调拨单号 <b>{filtered.filter((record) => !record.order).length}</b></span><span><Truck size={15} />未识别物流商 <b>{filtered.filter((record) => record.provider === "未识别" || record.provider === "未填写").length}</b></span><span><AlertTriangle size={15} />缺少跟踪号 <b>{missingTracking}</b></span></div></section>
        </div>}
      </div>
    </div>
  );
}

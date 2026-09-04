import { useMemo, useState } from "react";
import { AlertTriangle, Bot, CircleDollarSign, FileWarning, Scale, Truck } from "lucide-react";

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
type ComparisonMode = "providers" | "channels";
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
  const [view, setView] = useState<View>("rates");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>("providers");
  const [selectedRouteKey, setSelectedRouteKey] = useState("");
  const [selectedProviderName, setSelectedProviderName] = useState("");
  const [selectedProviderRouteKey, setSelectedProviderRouteKey] = useState("");
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

  const providerCoverageRows = useMemo(() => {
    const groups = new Map<string, {
      provider: string;
      records: number;
      amount: number;
      rates: number[];
      channels: Set<string>;
      routes: Set<string>;
      complexRates: number;
    }>();
    filtered.forEach((record) => {
      const row = groups.get(record.provider) || {
        provider: record.provider,
        records: 0,
        amount: 0,
        rates: [],
        channels: new Set<string>(),
        routes: new Set<string>(),
        complexRates: 0,
      };
      row.records += 1;
      row.amount += record.total || 0;
      if (record.unitPrice !== null) row.rates.push(record.unitPrice);
      if (record.channel && record.channel !== "未填写") row.channels.add(record.channel);
      row.routes.add(`${record.origin} → ${record.destination}|${record.transport}`);
      if (record.hasComplexRate) row.complexRates += 1;
      groups.set(record.provider, row);
    });
    return [...groups.values()].map((row) => ({
      ...row,
      channelCount: row.channels.size,
      routeCount: row.routes.size,
      averageRate: row.rates.length ? row.rates.reduce((sum, value) => sum + value, 0) / row.rates.length : null,
    })).sort((a, b) => b.channelCount - a.channelCount || b.records - a.records);
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
      key: `${row.route}|${row.transport}`,
      providerCount: row.providers.size,
      minRate: row.rates.length ? Math.min(...row.rates) : 0,
      maxRate: row.rates.length ? Math.max(...row.rates) : 0,
      averageRate: row.rates.length ? row.rates.reduce((sum, value) => sum + value, 0) / row.rates.length : 0,
    })).sort((a, b) => b.providerCount - a.providerCount || b.records - a.records);
  }, [filtered]);

  const selectedRoute = routeRows.find((row) => row.key === selectedRouteKey) || routeRows[0];
  const providerComparisons = useMemo(() => {
    if (!selectedRoute) return [];
    const groups = new Map<string, {
      provider: string;
      records: number;
      rates: number[];
      channels: Set<string>;
      latest: LogisticsQuoteRecord | null;
      complexRates: number;
    }>();
    filtered.forEach((record) => {
      const route = `${record.origin} → ${record.destination}`;
      if (route !== selectedRoute.route || record.transport !== selectedRoute.transport) return;
      const row = groups.get(record.provider) || {
        provider: record.provider,
        records: 0,
        rates: [],
        channels: new Set<string>(),
        latest: null,
        complexRates: 0,
      };
      row.records += 1;
      if (record.channel && record.channel !== "未填写") row.channels.add(record.channel);
      if (record.unitPrice !== null) row.rates.push(record.unitPrice);
      if (record.hasComplexRate) row.complexRates += 1;
      if (!row.latest || (record.pickupDate || "") >= (row.latest.pickupDate || "")) row.latest = record;
      groups.set(record.provider, row);
    });
    return [...groups.values()].map((row) => ({
      ...row,
      channels: [...row.channels],
      averageRate: row.rates.length ? row.rates.reduce((sum, value) => sum + value, 0) / row.rates.length : null,
      minRate: row.rates.length ? Math.min(...row.rates) : null,
      maxRate: row.rates.length ? Math.max(...row.rates) : null,
    })).sort((a, b) => {
      if (a.averageRate === null) return 1;
      if (b.averageRate === null) return -1;
      return a.averageRate - b.averageRate || a.provider.localeCompare(b.provider, "zh-CN");
    });
  }, [filtered, selectedRoute]);
  const comparableRates = providerComparisons.map((row) => row.averageRate).filter((value): value is number => value !== null);
  const lowestProviderRate = comparableRates.length ? Math.min(...comparableRates) : 0;
  const highestProviderRate = comparableRates.length ? Math.max(...comparableRates) : 0;
  const bestProvider = providerComparisons.find((row) => row.averageRate === lowestProviderRate);
  const priceSpread = lowestProviderRate > 0 ? (highestProviderRate - lowestProviderRate) / lowestProviderRate * 100 : 0;

  const selectedProvider = providerCoverageRows.find((row) => row.provider === selectedProviderName) || providerCoverageRows[0];
  const selectedProviderRoutes = useMemo(() => {
    if (!selectedProvider) return [];
    const groups = new Map<string, { key: string; route: string; transport: string; records: number; channels: Set<string> }>();
    filtered.forEach((record) => {
      if (record.provider !== selectedProvider.provider) return;
      const route = `${record.origin} → ${record.destination}`;
      const key = `${route}|${record.transport}`;
      const row = groups.get(key) || { key, route, transport: record.transport, records: 0, channels: new Set<string>() };
      row.records += 1;
      if (record.channel && record.channel !== "未填写") row.channels.add(record.channel);
      groups.set(key, row);
    });
    return [...groups.values()].map((row) => ({ ...row, channelCount: row.channels.size })).sort((a, b) => b.channelCount - a.channelCount || b.records - a.records);
  }, [filtered, selectedProvider]);
  const selectedProviderRoute = selectedProviderRoutes.find((row) => row.key === selectedProviderRouteKey) || selectedProviderRoutes[0];
  const channelComparisons = useMemo(() => {
    if (!selectedProvider || !selectedProviderRoute) return [];
    const groups = new Map<string, {
      channel: string;
      records: number;
      rates: number[];
      amount: number;
      weight: number;
      latest: LogisticsQuoteRecord | null;
      complexRates: number;
    }>();
    filtered.forEach((record) => {
      const route = `${record.origin} → ${record.destination}`;
      if (record.provider !== selectedProvider.provider || route !== selectedProviderRoute.route || record.transport !== selectedProviderRoute.transport) return;
      const row = groups.get(record.channel) || { channel: record.channel, records: 0, rates: [], amount: 0, weight: 0, latest: null, complexRates: 0 };
      row.records += 1;
      row.amount += record.total || 0;
      row.weight += record.billingWeight || 0;
      if (record.unitPrice !== null) row.rates.push(record.unitPrice);
      if (record.hasComplexRate) row.complexRates += 1;
      if (!row.latest || (record.pickupDate || "") >= (row.latest.pickupDate || "")) row.latest = record;
      groups.set(record.channel, row);
    });
    return [...groups.values()].map((row) => ({
      ...row,
      averageRate: row.rates.length ? row.rates.reduce((sum, value) => sum + value, 0) / row.rates.length : null,
      minRate: row.rates.length ? Math.min(...row.rates) : null,
      maxRate: row.rates.length ? Math.max(...row.rates) : null,
    })).sort((a, b) => {
      if (a.averageRate === null) return 1;
      if (b.averageRate === null) return -1;
      return a.averageRate - b.averageRate || a.channel.localeCompare(b.channel, "zh-CN");
    });
  }, [filtered, selectedProvider, selectedProviderRoute]);
  const channelRates = channelComparisons.map((row) => row.averageRate).filter((value): value is number => value !== null);
  const lowestChannelRate = channelRates.length ? Math.min(...channelRates) : 0;
  const highestChannelRate = channelRates.length ? Math.max(...channelRates) : 0;
  const bestChannel = channelComparisons.find((row) => row.averageRate === lowestChannelRate);
  const channelSpread = lowestChannelRate > 0 ? (highestChannelRate - lowestChannelRate) / lowestChannelRate * 100 : 0;

  const complexRates = filtered.filter((record) => record.hasComplexRate).length;
  const missingWeights = filtered.filter((record) => record.billingWeight === null).length;
  const missingAmounts = filtered.filter((record) => record.missingAmount).length;
  const sendToAi = () => onSendToAssistant([
    "请根据下面的物流报价看板，分析线路价格、物流商差异、费用异常和可优化的采购动作。",
    `数据源：${report.sourceName}；筛选后 ${filtered.length} 条，${orders} 个调拨单。`,
    `记录总金额 ${amountLabel(totalAmount)}，计费重 ${number.format(totalWeight)}，平均可识别单价 ${averageRate ? money.format(averageRate) : "暂无"}。`,
    `复杂报价 ${complexRates} 条，缺计费重 ${missingWeights} 条，缺运费/总金额 ${missingAmounts} 条。`,
    `主要物流商：${providerRows.slice(0, 5).map((row) => `${row.name} ${row.records}条，金额${amountLabel(row.amount)}`).join("；") || "暂无"}`,
    comparisonMode === "providers" && selectedRoute ? `当前物流商比价线路：${selectedRoute.route}（${selectedRoute.transport}）；${providerComparisons.map((row) => `${row.provider} 平均单价${row.averageRate === null ? "待复核" : money.format(row.averageRate)}`).join("；") || "暂无可比报价"}。` : "",
    comparisonMode === "channels" && selectedProvider && selectedProviderRoute ? `当前渠道比价：${selectedProvider.provider}，${selectedProviderRoute.route}（${selectedProviderRoute.transport}）；${channelComparisons.map((row) => `${row.channel} 平均单价${row.averageRate === null ? "待复核" : money.format(row.averageRate)}`).join("；") || "暂无可比报价"}。` : "",
  ].join("\n\n"));

  const openProviderChannels = (provider: string) => {
    setFilters((current) => ({ ...current, provider: "全部", channel: "全部" }));
    setSelectedProviderName(provider);
    setSelectedProviderRouteKey("");
    setComparisonMode("channels");
    setView("rates");
  };

  const changeView = (nextView: View) => {
    if (nextView === "rates") setFilters((current) => ({ ...current, provider: "全部", channel: "全部" }));
    setView(nextView);
  };
  const visibleFilterKeys: FilterKey[] = view === "rates"
    ? ["transport", "origin", "destination"]
    : ["provider", "transport", "channel", "origin", "destination"];

  return <div className="ct-shell lq-shell">
    <div className="ct-tabs">
      {(["overview", "rates", "quality"] as View[]).map((key) => <button key={key} className={view === key ? "active" : ""} onClick={() => changeView(key)}>{{ overview: "报价总览", rates: "报价对比", quality: "数据复核" }[key]}</button>)}
      <span className="ct-tabs-spacer" />
      <button className="ct-ai-action" onClick={sendToAi}><Bot size={14} />交给 AI 分析</button>
    </div>

    <div className="ct-filters">
      <div className="ct-period-row">
        <div className="ct-months">{["全部", ...months].map((month) => <button key={month} className={filters.month === month ? "active" : ""} onClick={() => setFilters((current) => ({ ...current, month, dateFrom: "", dateTo: "" }))}>{month === "全部" ? "全部月份" : month.replace("-", "/")}</button>)}</div>
        <div className="ct-date-range"><b>提货日期</b><label><span>开始</span><input type="date" value={filters.dateFrom} max={filters.dateTo || undefined} onChange={(event) => setFilters((current) => ({ ...current, month: "全部", dateFrom: event.target.value }))} /></label><i>至</i><label><span>结束</span><input type="date" value={filters.dateTo} min={filters.dateFrom || undefined} onChange={(event) => setFilters((current) => ({ ...current, month: "全部", dateTo: event.target.value }))} /></label></div>
      </div>
      <div className="ct-filter-row lq-filter-row">
        {visibleFilterKeys.map((key) => <label key={key}><span>{{ provider: "物流商", transport: "运输方式", channel: "物流渠道", origin: "发货地", destination: "目的地" }[key]}</span><select value={filters[key]} onChange={(event) => setFilters((current) => ({ ...current, [key]: event.target.value }))}><option>全部</option>{options(report.records, key).map((value) => <option key={value}>{value}</option>)}</select></label>)}
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
        <section className="ct-panel"><header><div><small>CARRIER COST</small><h2>物流商报价汇总</h2></div><span>{providerRows.length} 家物流商</span></header><div className="ct-compact-table"><table><thead><tr><th>物流商</th><th>报价记录</th><th>平均单价</th><th>记录金额</th><th></th></tr></thead><tbody>{providerRows.slice(0, 8).map((row) => <tr key={row.name}><td><strong>{row.name}</strong></td><td>{row.records} 条</td><td>{row.averageRate ? money.format(row.averageRate) : "—"}</td><td>{amountLabel(row.amount)}</td><td><button onClick={() => openProviderChannels(row.name)}>查看渠道</button></td></tr>)}</tbody></table></div></section>
        <section className="ct-panel"><header><div><small>ROUTE COVERAGE</small><h2>可比线路</h2></div><span>按物流商数</span></header><div className="lq-route-list">{routeRows.slice(0, 8).map((row) => <button key={row.key} onClick={() => { setSelectedRouteKey(row.key); setView("rates"); }}><span><strong>{row.route}</strong><small>{row.transport} · {row.providerCount} 家物流商</small></span><b>查看 {row.records} 条</b></button>)}</div></section>
        <section className="ct-panel ct-table-panel lq-coverage-panel"><header><div><small>CARRIER × CHANNEL</small><h2>物流商与渠道覆盖</h2></div><span>{providerCoverageRows.length} 家物流商</span></header><div className="ct-table-scroll"><table><thead><tr><th>物流商</th><th>渠道数</th><th>覆盖线路</th><th>报价记录</th><th>平均单价</th><th>记录金额</th><th>待复核</th><th></th></tr></thead><tbody>{providerCoverageRows.map((row) => <tr key={row.provider}><td><strong>{row.provider}</strong></td><td>{row.channelCount}</td><td>{row.routeCount}</td><td>{row.records}</td><td>{row.averageRate === null ? "—" : money.format(row.averageRate)}</td><td>{amountLabel(row.amount)}</td><td>{row.complexRates || "—"}</td><td><button className="lq-table-action" onClick={() => openProviderChannels(row.provider)}>查看渠道</button></td></tr>)}</tbody></table></div></section>
      </div>}

      {view === "rates" && <section className="ct-panel ct-table-panel lq-compare-panel">
        <header><div><small>QUOTE COMPARISON</small><h2>{comparisonMode === "providers" ? "同线路物流商比价" : "同物流商渠道比价"}</h2></div><div className="lq-compare-mode"><button className={comparisonMode === "providers" ? "active" : ""} onClick={() => { setComparisonMode("providers"); setFilters((current) => ({ ...current, provider: "全部", channel: "全部" })); }}>比物流商</button><button className={comparisonMode === "channels" ? "active" : ""} onClick={() => { setComparisonMode("channels"); setFilters((current) => ({ ...current, provider: "全部", channel: "全部" })); }}>比渠道</button></div></header>
        {comparisonMode === "providers" && selectedRoute ? <>
          <div className="lq-compare-toolbar">
            <label><span>对比线路</span><select value={selectedRoute.key} onChange={(event) => setSelectedRouteKey(event.target.value)}>{routeRows.map((row) => <option key={row.key} value={row.key}>{row.route} · {row.transport} · {row.providerCount} 家</option>)}</select></label>
            <div className="lq-compare-summary">
              <article><span>可比物流商</span><strong>{providerComparisons.length} 家</strong></article>
              <article><span>最低平均价</span><strong>{lowestProviderRate ? money.format(lowestProviderRate) : "—"}</strong><small>{bestProvider?.provider || "暂无数值报价"}</small></article>
              <article><span>最高价差</span><strong>{priceSpread ? `${number.format(priceSpread)}%` : "—"}</strong><small>相对最低平均价</small></article>
            </div>
          </div>
          <div className="ct-table-scroll lq-compare-table"><table><thead><tr><th>物流商</th><th>渠道</th><th>最近报价</th><th>平均单价</th><th>历史价格区间</th><th>比最低价</th><th>样本 / 更新</th></tr></thead><tbody>{providerComparisons.map((row) => {
            const difference = row.averageRate !== null && lowestProviderRate ? row.averageRate - lowestProviderRate : null;
            const differencePercent = difference !== null && lowestProviderRate ? difference / lowestProviderRate * 100 : null;
            const isLowest = row.averageRate !== null && row.averageRate === lowestProviderRate;
            return <tr key={row.provider} className={isLowest ? "lq-best-provider" : ""}>
              <td><strong>{row.provider}</strong>{isLowest && <span className="lq-best-tag">当前最低</span>}</td>
              <td>{row.channels.join("、") || "—"}</td>
              <td><strong>{row.latest?.unitPrice !== null && row.latest?.unitPrice !== undefined ? money.format(row.latest.unitPrice) : row.latest?.unitPriceText || "—"}</strong>{row.latest?.hasComplexRate && <small>复杂报价，需复核</small>}</td>
              <td><strong>{row.averageRate === null ? "—" : money.format(row.averageRate)}</strong></td>
              <td>{row.minRate === null || row.maxRate === null ? "—" : row.minRate === row.maxRate ? money.format(row.minRate) : `${money.format(row.minRate)} - ${money.format(row.maxRate)}`}</td>
              <td>{isLowest ? <span className="lq-saving">基准</span> : difference === null ? "—" : <span className="lq-price-gap">+{money.format(difference)}<small>+{number.format(differencePercent || 0)}%</small></span>}</td>
              <td><strong>{row.records} 条</strong><small>{row.latest?.pickupDate || "无日期"}{row.complexRates ? ` · ${row.complexRates} 条待复核` : ""}</small></td>
            </tr>;
          })}</tbody></table></div>
          <p className="lq-compare-note">比较口径：相同发货地、目的地和运输方式；平均价基于当前日期及筛选范围内可识别的数字单价。</p>
        </> : comparisonMode === "providers" ? <div className="ct-empty">当前筛选范围内没有可对比的线路</div> : null}

        {comparisonMode === "channels" && selectedProvider && selectedProviderRoute ? <>
          <div className="lq-compare-toolbar lq-channel-toolbar">
            <div className="lq-compare-selectors">
              <label><span>物流商</span><select value={selectedProvider.provider} onChange={(event) => { setSelectedProviderName(event.target.value); setSelectedProviderRouteKey(""); }}>{providerCoverageRows.map((row) => <option key={row.provider} value={row.provider}>{row.provider} · {row.channelCount} 个渠道</option>)}</select></label>
              <label><span>对比线路</span><select value={selectedProviderRoute.key} onChange={(event) => setSelectedProviderRouteKey(event.target.value)}>{selectedProviderRoutes.map((row) => <option key={row.key} value={row.key}>{row.route} · {row.transport} · {row.channelCount} 个渠道</option>)}</select></label>
            </div>
            <div className="lq-compare-summary">
              <article><span>当前渠道</span><strong>{channelComparisons.length} 个</strong><small>{selectedProvider.provider}</small></article>
              <article><span>最低平均价</span><strong>{lowestChannelRate ? money.format(lowestChannelRate) : "—"}</strong><small>{bestChannel?.channel || "暂无数值报价"}</small></article>
              <article><span>渠道最高价差</span><strong>{channelSpread ? `${number.format(channelSpread)}%` : "—"}</strong><small>相对最低平均价</small></article>
            </div>
          </div>
          <div className="ct-table-scroll lq-compare-table"><table><thead><tr><th>渠道</th><th>最近报价</th><th>平均单价</th><th>历史价格区间</th><th>比最低渠道</th><th>计费重 / 金额</th><th>样本 / 更新</th></tr></thead><tbody>{channelComparisons.map((row) => {
            const difference = row.averageRate !== null && lowestChannelRate ? row.averageRate - lowestChannelRate : null;
            const differencePercent = difference !== null && lowestChannelRate ? difference / lowestChannelRate * 100 : null;
            const isLowest = row.averageRate !== null && row.averageRate === lowestChannelRate;
            return <tr key={row.channel} className={isLowest ? "lq-best-provider" : ""}>
              <td><strong>{row.channel}</strong>{isLowest && <span className="lq-best-tag">当前最低</span>}</td>
              <td><strong>{row.latest?.unitPrice !== null && row.latest?.unitPrice !== undefined ? money.format(row.latest.unitPrice) : row.latest?.unitPriceText || "—"}</strong>{row.latest?.hasComplexRate && <small>复杂报价，需复核</small>}</td>
              <td><strong>{row.averageRate === null ? "—" : money.format(row.averageRate)}</strong></td>
              <td>{row.minRate === null || row.maxRate === null ? "—" : row.minRate === row.maxRate ? money.format(row.minRate) : `${money.format(row.minRate)} - ${money.format(row.maxRate)}`}</td>
              <td>{isLowest ? <span className="lq-saving">基准</span> : difference === null ? "—" : <span className="lq-price-gap">+{money.format(difference)}<small>+{number.format(differencePercent || 0)}%</small></span>}</td>
              <td><strong>{row.weight ? `${number.format(row.weight)} kg` : "—"}</strong><small>{amountLabel(row.amount)}</small></td>
              <td><strong>{row.records} 条</strong><small>{row.latest?.pickupDate || "无日期"}{row.complexRates ? ` · ${row.complexRates} 条待复核` : ""}</small></td>
            </tr>;
          })}</tbody></table></div>
          <p className="lq-compare-note">比较口径：固定物流商、发货地、目的地和运输方式，只比较其不同物流渠道；跨线路渠道不直接比较均价。</p>
        </> : comparisonMode === "channels" ? <div className="ct-empty">当前筛选范围内没有可对比的物流商渠道</div> : null}
      </section>}

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

// src/Chart.tsx
// 渲染 chart_render 工具返回的 Chart.js 配置（details.chartConfig）。
// chart_render 工具在 details.chartConfig 里返回标准 Chart.js 配置：
//   { type: "bar"|"line"|"pie"|"doughnut", data: {labels, datasets}, options }
// 这里用 react-chartjs-2 的通用 Chart 组件渲染。

import {
  Chart as ChartJS,
  ArcElement,
  BarController,
  LineController,
  PieController,
  DoughnutController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { Chart } from "react-chartjs-2";

ChartJS.register(
  ArcElement,
  BarController,
  LineController,
  PieController,
  DoughnutController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend
);

interface ChartViewProps {
  config: any;
}

/** 从工具结果中提取 chartConfig（兼容几种可能的 Pi toolResult 透传结构） */
export function extractChartConfig(result: any): any | null {
  if (!result) return null;
  // 直接挂在 details 上
  if (result.details?.chartConfig) return result.details.chartConfig;
  if (result.chartConfig) return result.chartConfig;
  // content 数组里带 details 的块
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part?.details?.chartConfig) return part.details.chartConfig;
    }
  }
  return null;
}

export function ChartView({ config }: ChartViewProps) {
  if (!config?.type || !config?.data) return null;
  try {
    return (
      <div className="chart-view">
        <Chart type={config.type} data={config.data} options={config.options || {}} />
      </div>
    );
  } catch (e) {
    return <div className="chart-error">图表渲染失败：{String(e)}</div>;
  }
}

import React from "react";
import { useTranslation } from "react-i18next";

interface MapTooltipProps {
  name: string;
  count: number;
  flag: string;
  x: number;
  y: number;
}

export const MapTooltip: React.FC<MapTooltipProps> = ({ name, count, flag, x, y }) => {
  const { t } = useTranslation();
  return (
    <div
      className="absolute pointer-events-none bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm px-3 py-2 rounded-lg shadow-xl border border-gray-200/50 dark:border-slate-800/50 text-xs z-50 flex flex-col gap-1 transition-all duration-75 text-gray-900 dark:text-gray-100"
      style={{
        left: `${x}px`,
        top: `${y}px`,
        transform: "translate(-50%, -100%)",
      }}
    >
      <div className="flex items-center gap-1.5 font-semibold whitespace-nowrap">
        <span className="text-sm">{flag}</span>
        <span>{name}</span>
      </div>
      <div className="text-gray-500 dark:text-gray-400 whitespace-nowrap">
        {count.toLocaleString()} {t("analytics.queries")}
      </div>
    </div>
  );
};

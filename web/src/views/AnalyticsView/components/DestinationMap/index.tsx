import React, { useState, useRef } from "react";
import {
  ComposableMap,
  ZoomableGroup,
  Geographies,
  Geography,
  createCoordinates,
  createTranslateExtent,
} from "@vnedyalk0v/react19-simple-maps";
import { getFlagEmoji } from "../../utils";
import { numericToAlpha2 } from "../../countryMapping";

import { useMapData } from "./hooks/useMapData";
import { ZoomControls } from "./components/ZoomControls";
import { Legend } from "./components/Legend";
import { MapTooltip } from "./components/MapTooltip";

interface DestinationItem {
  dest_geoip: string;
  count: number;
}

interface DestinationMapProps {
  destinations: DestinationItem[];
}

export const DestinationMap: React.FC<DestinationMapProps> = ({ destinations }) => {
  const {
    geographyData,
    destinationMap,
    scaleConfig,
    getLevel,
    formatNumber,
  } = useMapData(destinations);

  const [position, setPosition] = useState({ coordinates: createCoordinates(0, 0), zoom: 1 });
  const [hoveredCountry, setHoveredCountry] = useState<{
    name: string;
    code: string;
    count: number;
    flag: string;
    x: number;
    y: number;
  } | null>(null);
  
  const containerRef = useRef<HTMLDivElement>(null);

  const bounds = React.useMemo(() => {
    return createTranslateExtent(
      createCoordinates(-100, -50),
      createCoordinates(900, 450)
    );
  }, []);

  const handleZoomIn = () => {
    if (position.zoom >= 8) return;
    setPosition((pos) => ({ ...pos, zoom: pos.zoom * 1.5 }));
  };

  const handleZoomOut = () => {
    if (position.zoom <= 1) return;
    setPosition((pos) => ({ ...pos, zoom: pos.zoom / 1.5 }));
  };

  const handleReset = () => {
    setPosition({ coordinates: createCoordinates(0, 0), zoom: 1 });
  };

  return (
    <div className="relative w-full h-100 mt-4 bg-gray-50 dark:bg-slate-950 rounded-xl overflow-hidden border border-gray-100 dark:border-slate-800 flex flex-col justify-between shadow-sm">
      {/* Map wrapper */}
      <div
        ref={containerRef}
        className="relative w-full flex-1 overflow-hidden select-none cursor-grab active:cursor-grabbing"
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as SVGElement).tagName === "svg") {
            setHoveredCountry(null);
          }
        }}
      >
        <ComposableMap
          projection="geoEqualEarth"
          width={800}
          height={400}
          style={{ width: "100%", height: "100%" }}
        >
          <ZoomableGroup
            zoom={position.zoom}
            center={position.coordinates}
            onMoveEnd={(pos) => setPosition({ coordinates: createCoordinates(pos.coordinates[0], pos.coordinates[1]), zoom: pos.zoom })}
            maxZoom={8}
            minZoom={1}
            enablePan={true}
            translateExtent={bounds}
          >
            {geographyData && (
              <Geographies geography={geographyData}>
                {({ geographies }) =>
                  geographies.map((geo) => {
                    const countryCode = numericToAlpha2[geo.id];
                    const dest = countryCode ? destinationMap[countryCode] : null;
                    const count = dest?.count || 0;
                    const fillLevel = getLevel(count);

                    return (
                      <Geography
                        key={geo.rsmKey}
                        geography={geo}
                        onMouseEnter={(event) => {
                          if (!countryCode) return;
                          const name = dest?.name || geo.properties.name;
                          const flag = getFlagEmoji(countryCode);
                          const containerRect = containerRef.current?.getBoundingClientRect();
                          const x = event.clientX - (containerRect?.left || 0);
                          const y = event.clientY - (containerRect?.top || 0) - 15;
                          setHoveredCountry({
                            name,
                            code: countryCode,
                            count,
                            flag,
                            x,
                            y,
                          });
                        }}
                        onMouseMove={(event) => {
                          const containerRect = containerRef.current?.getBoundingClientRect();
                          const x = event.clientX - (containerRect?.left || 0);
                          const y = event.clientY - (containerRect?.top || 0) - 15;
                          setHoveredCountry((prev) => (prev ? { ...prev, x, y } : null));
                        }}
                        onMouseLeave={() => {
                          setHoveredCountry(null);
                        }}
                        onClick={(event) => {
                          if (!countryCode) return;
                          const name = dest?.name || geo.properties.name;
                          const flag = getFlagEmoji(countryCode);
                          const containerRect = containerRef.current?.getBoundingClientRect();
                          const x = event.clientX - (containerRect?.left || 0);
                          const y = event.clientY - (containerRect?.top || 0) - 15;
                          setHoveredCountry({
                            name,
                            code: countryCode,
                            count,
                            flag,
                            x,
                            y,
                          });
                        }}
                        style={{
                          default: {
                            fill: `var(--map-color-${fillLevel})`,
                            stroke: "var(--map-stroke)",
                            strokeWidth: 0.5,
                            outline: "none",
                            transition: "fill 250ms, stroke 250ms",
                          },
                          hover: {
                            fill: "var(--map-hover)",
                            stroke: "var(--map-stroke)",
                            strokeWidth: 0.5,
                            outline: "none",
                            cursor: "pointer",
                          },
                          pressed: {
                            fill: "var(--map-hover)",
                            stroke: "var(--map-stroke)",
                            strokeWidth: 0.5,
                            outline: "none",
                          },
                        }}
                      />
                    );
                  })
                }
              </Geographies>
            )}
          </ZoomableGroup>
        </ComposableMap>

        {/* Tooltip */}
        {hoveredCountry && (
          <MapTooltip
            name={hoveredCountry.name}
            count={hoveredCountry.count}
            flag={hoveredCountry.flag}
            x={hoveredCountry.x}
            y={hoveredCountry.y}
          />
        )}
      </div>

      {/* Zoom Controls */}
      <ZoomControls
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onReset={handleReset}
      />

      {/* Legend */}
      <Legend
        maxThreshold={scaleConfig.maxThreshold}
        formatNumber={formatNumber}
      />
    </div>
  );
};

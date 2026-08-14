import type { SVGProps } from "react";

/**
 * 内联 SVG 图标库：统一 1.6 描边、圆头端点，随 currentColor 着色。
 * 不引入第三方图标库，保持包体轻量、风格统一（M5 主题系统可替换图标集）。
 */

const base: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export const IconGrid = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </svg>
);

export const IconFileText = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
    <path d="M9 12h6M9 16h6" />
  </svg>
);

export const IconSliders = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M4 6h16M4 12h16M4 18h16" />
    <circle cx="8" cy="6" r="1.8" />
    <circle cx="16" cy="12" r="1.8" />
    <circle cx="11" cy="18" r="1.8" />
  </svg>
);

export const IconCheckSquare = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M8.5 12.5l2.4 2.4 4.6-5.4" />
  </svg>
);

export const IconNotebook = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M9 3v18" />
    <path d="M12.5 8h3M12.5 12h3" />
  </svg>
);

export const IconSparkle = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z" />
    <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
  </svg>
);

export const IconGlobe = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M4 12h16" />
    <path d="M12 4c2.4 2.5 2.4 13 0 16M12 4c-2.4 2.5-2.4 13 0 16" />
  </svg>
);

export const IconGear = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7" />
  </svg>
);

export const IconSun = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3.6" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
  </svg>
);

export const IconMoon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M20 13.2A8 8 0 1 1 10.8 4a6.4 6.4 0 0 0 9.2 9.2z" />
  </svg>
);

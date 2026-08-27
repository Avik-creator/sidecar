import type { Harness } from "@shared/types";
import { MARK_VIEWBOX, markLayout } from "@shared/mark";

export function SidecarMark({ className }: { className?: string }) {
  const layout = markLayout();
  return (
    <svg className={className} viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`} aria-hidden="true">
      {layout.petals.map((circle, index) => (
        <circle
          key={index}
          cx={circle.x}
          cy={circle.y}
          r={circle.r}
          fill="none"
          stroke="currentColor"
          strokeWidth={layout.stroke}
        />
      ))}
      <circle cx={layout.cx} cy={layout.cy} r={layout.centerR} fill="currentColor" />
    </svg>
  );
}

export function HarnessMark({ harness, className }: { harness: Harness; className?: string }) {
  switch (harness) {
    case "claude":
      return (
        <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 2.2 8.9 6.1 12.8 7 8.9 7.9 8 11.8 7.1 7.9 3.2 7 7.1 6.1Z"
            fill="currentColor"
          />
          <circle cx="8" cy="14" r="1.1" fill="currentColor" />
        </svg>
      );
    case "codex":
      return (
        <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M5.5 8.2 7.3 9.6 5.5 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8.2 11h2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "cursor":
      return (
        <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4 3.2 12.4 8 8.1 9.1 6.7 13.2Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      );
    default: {
      const exhaustive: never = harness;
      return exhaustive;
    }
  }
}

export function AgentsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="2.5" y="3.5" width="11" height="4" rx="1.2" />
      <rect x="2.5" y="9" width="11" height="3.5" rx="1.2" />
    </svg>
  );
}

export function SetupIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4 4.5h8M4 8h8M4 11.5h5" />
      <circle cx="12" cy="11.5" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function UsageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3.5 12V8.5M7 12V4.5M10.5 12V7M13.5 12V5.5" />
    </svg>
  );
}

export function ImproveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 12.5V3.5M8 3.5 5 6.5M8 3.5l3 3" />
    </svg>
  );
}

export function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.2 2.8h3.6L11.5 7H9.2L8 14 6.8 7H4.5Z" />
    </svg>
  );
}

export function BellIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.2 7.1a3.8 3.8 0 0 1 7.6 0c0 2.6.9 3.6.9 3.6H3.3s.9-1 .9-3.6Z" />
      <path d="M6.6 12.3a1.4 1.4 0 0 0 2.8 0" />
    </svg>
  );
}

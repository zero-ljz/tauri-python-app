import { type CSSProperties, type HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  value: number;
}

export function Progress({ className, value, ...props }: ProgressProps) {
  const clamped = Math.max(0, Math.min(value, 1));
  return (
    <div className={cn("ui-progress", className)} {...props}>
      <div
        className="ui-progress__bar"
        style={{ "--progress": `${clamped * 100}%` } as CSSProperties}
      />
    </div>
  );
}

"use client";

import { useState } from "react";
import type { LeadRow } from "./leadTypes";
import { displayAvatarUrlForLead, initialsFromLead } from "@/lib/leadAvatar";

type LeadAvatarProps = {
  lead: LeadRow;
  size?: "sm" | "md";
  className?: string;
};

const sizeClass = {
  sm: "h-9 w-9 text-xs",
  md: "h-14 w-14 text-lg",
};

export function LeadAvatar({ lead, size = "sm", className = "" }: LeadAvatarProps) {
  const [broken, setBroken] = useState(false);
  const url = displayAvatarUrlForLead(lead);
  const sc = sizeClass[size];

  if (url && !broken) {
    return (
      <img
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className={`${sc} shrink-0 rounded-full object-cover ring-1 ring-[var(--border)] ${className}`}
      />
    );
  }

  return (
    <div
      className={`flex ${sc} shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--text)_8%,var(--surface))] font-semibold text-[var(--muted)] ring-1 ring-[var(--border)] ${className}`}
      aria-hidden
    >
      {initialsFromLead(lead)}
    </div>
  );
}

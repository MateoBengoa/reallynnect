"use client";

import { useCallback, useState } from "react";

const ACTOR_URL = "https://apify.com/harvestapi/linkedin-profile-search";

const COMPANY_HEADCOUNT = [
  { id: "A", label: "Self-Employed" },
  { id: "B", label: "1-10" },
  { id: "C", label: "11-50" },
  { id: "D", label: "51-200" },
  { id: "E", label: "201-500" },
  { id: "F", label: "501-1,000" },
  { id: "G", label: "1,001-5,000" },
  { id: "H", label: "5,001-10,000" },
  { id: "I", label: "10,001+" },
];

const YEARS_MAPPING = [
  { id: "1", label: "Less than 1 year" },
  { id: "2", label: "1 to 2 years" },
  { id: "3", label: "3 to 5 years" },
  { id: "4", label: "6 to 10 years" },
  { id: "5", label: "More than 10 years" },
];

const SENIORITY_LEVELS = [
  { id: "100", label: "In Training" },
  { id: "110", label: "Entry Level" },
  { id: "120", label: "Senior" },
  { id: "130", label: "Strategic" },
  { id: "200", label: "Entry Level Manager" },
  { id: "210", label: "Experienced Manager" },
  { id: "220", label: "Director" },
  { id: "300", label: "Vice President" },
  { id: "310", label: "CXO" },
  { id: "320", label: "Owner / Partner" },
];

const FUNCTIONS = [
  { id: "1", label: "Accounting" },
  { id: "2", label: "Administrative" },
  { id: "3", label: "Arts and Design" },
  { id: "4", label: "Business Development" },
  { id: "5", label: "Community and Social Services" },
  { id: "6", label: "Consulting" },
  { id: "7", label: "Education" },
  { id: "8", label: "Engineering" },
  { id: "9", label: "Entrepreneurship" },
  { id: "10", label: "Finance" },
  { id: "11", label: "Healthcare Services" },
  { id: "12", label: "Human Resources" },
  { id: "13", label: "Information Technology" },
  { id: "14", label: "Legal" },
  { id: "15", label: "Marketing" },
  { id: "16", label: "Media and Communication" },
  { id: "17", label: "Military and Protective Services" },
  { id: "18", label: "Operations" },
  { id: "19", label: "Product Management" },
  { id: "20", label: "Program and Project Management" },
  { id: "21", label: "Purchasing" },
  { id: "22", label: "Quality Assurance" },
  { id: "23", label: "Real Estate" },
  { id: "24", label: "Research" },
  { id: "25", label: "Sales" },
  { id: "26", label: "Customer Success and Support" },
];

interface ApifyFormState {
  locations: string[];
  maxItems: number;
  autoQuerySegmentation: boolean;
  profileScraperMode: "Full" | "Basic";
  recentlyChangedJobs: boolean;
  companyHeadcount: string[];
  yearsOfExperienceIds: string[];
  yearsAtCurrentCompanyIds: string[];
  seniorityLevelIds: string[];
  functionIds: string[];
  profileLanguages: string[];
  industryIds: string[];
  firstNames: string[];
  lastNames: string[];
}

const DEFAULT_FORM: ApifyFormState = {
  locations: ["Uruguay"],
  maxItems: 20,
  autoQuerySegmentation: false,
  profileScraperMode: "Full",
  recentlyChangedJobs: false,
  companyHeadcount: [],
  yearsOfExperienceIds: [],
  yearsAtCurrentCompanyIds: [],
  seniorityLevelIds: [],
  functionIds: [],
  profileLanguages: [],
  industryIds: [],
  firstNames: [],
  lastNames: [],
};

function ChipToggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-[color-mix(in_srgb,var(--accent)_55%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_22%,transparent)] text-[var(--accent)]"
          : "border-[var(--border)] text-[var(--muted)] hover:border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] hover:text-[var(--text)]"
      }`}
    >
      {label}
    </button>
  );
}

function TagInput({
  label,
  values,
  onChange,
  placeholder = "Presiona Enter para agregar",
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [val, setVal] = useState("");

  const handleAdd = () => {
    const trimmed = val.trim();
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed]);
    }
    setVal("");
  };

  const remove = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_50%,transparent)] p-3">
      <span className="block text-xs font-semibold text-[var(--text)]">{label}</span>
      <div className="flex flex-wrap gap-2">
        {values.map((v, i) => (
          <div
            key={v + i}
            className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-2 py-1 text-xs text-[var(--text)]"
          >
            {v}
            <button
              type="button"
              className="text-[var(--muted)] hover:text-red-500"
              onClick={() => remove(i)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className="input-field flex-1 py-1.5 text-xs"
          placeholder={placeholder}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
        />
        <button
          type="button"
          onClick={handleAdd}
          className="rounded-md bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] px-3 text-xs font-medium text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_25%,transparent)]"
        >
          + Add
        </button>
      </div>
    </div>
  );
}

type Props = {
  busy: boolean;
  onEnqueue: (apify_input: Record<string, unknown>) => void;
};

export function LeadFinderApifyForm({ busy, onEnqueue }: Props) {
  const [form, setForm] = useState<ApifyFormState>(DEFAULT_FORM);

  const update = <K extends keyof ApifyFormState>(k: K, val: ApifyFormState[K]) => {
    setForm((p) => ({ ...p, [k]: val }));
  };

  const toggleArray = (key: keyof ApifyFormState, id: string) => {
    setForm((p) => {
      const arr = p[key] as string[];
      if (arr.includes(id)) return { ...p, [key]: arr.filter((x) => x !== id) };
      return { ...p, [key]: [...arr, id] };
    });
  };

  const submit = useCallback(() => {
    const payload: Record<string, unknown> = {
      autoQuerySegmentation: form.autoQuerySegmentation,
      maxItems: form.maxItems,
      profileScraperMode: form.profileScraperMode,
      recentlyChangedJobs: form.recentlyChangedJobs,
    };

    if (form.locations.length) payload.locations = form.locations;
    if (form.companyHeadcount.length) payload.companyHeadcount = form.companyHeadcount;
    if (form.yearsOfExperienceIds.length) payload.yearsOfExperienceIds = form.yearsOfExperienceIds;
    if (form.yearsAtCurrentCompanyIds.length) payload.yearsAtCurrentCompanyIds = form.yearsAtCurrentCompanyIds;
    if (form.seniorityLevelIds.length) payload.seniorityLevelIds = form.seniorityLevelIds;
    if (form.functionIds.length) payload.functionIds = form.functionIds;
    if (form.profileLanguages.length) payload.profileLanguages = form.profileLanguages;
    if (form.industryIds.length) payload.industryIds = form.industryIds;
    if (form.firstNames.length) payload.firstNames = form.firstNames;
    if (form.lastNames.length) payload.lastNames = form.lastNames;

    onEnqueue(payload);
  }, [form, onEnqueue]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <label className="block flex-1 space-y-1">
          <span className="text-xs font-semibold text-[var(--text)]">maxItems (Leads a extraer)</span>
          <input
            type="number"
            className="input-field py-1.5"
            value={form.maxItems}
            min={1}
            max={50000}
            onChange={(e) => update("maxItems", Number.parseInt(e.target.value) || 20)}
          />
        </label>
        <label className="block flex-1 space-y-1">
          <span className="text-xs font-semibold text-[var(--text)]">profileScraperMode</span>
          <select
            className="input-field py-1.5"
            value={form.profileScraperMode}
            onChange={(e) => update("profileScraperMode", e.target.value as "Full")}
          >
            <option value="Full">Full</option>
            <option value="Basic">Basic</option>
          </select>
        </label>
      </div>

      <div className="flex gap-4">
        <label className="flex items-center gap-2 text-xs font-medium text-[var(--text)]">
          <input
            type="checkbox"
            checked={form.autoQuerySegmentation}
            onChange={(e) => update("autoQuerySegmentation", e.target.checked)}
          />
          autoQuerySegmentation
        </label>
        <label className="flex items-center gap-2 text-xs font-medium text-[var(--text)]">
          <input
            type="checkbox"
            checked={form.recentlyChangedJobs}
            onChange={(e) => update("recentlyChangedJobs", e.target.checked)}
          />
          recentlyChangedJobs
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <TagInput label="Locations Filter" values={form.locations} onChange={(v) => update("locations", v)} placeholder="Ej: Uruguay" />
        <TagInput label="Profile Languages Filter" values={form.profileLanguages} onChange={(v) => update("profileLanguages", v)} placeholder="Ej: Spanish" />
        <TagInput label="Industry IDs Filter (Text)" values={form.industryIds} onChange={(v) => update("industryIds", v)} placeholder="Ej: 96 (Software)" />
        <TagInput label="First Names Filter" values={form.firstNames} onChange={(v) => update("firstNames", v)} />
        <TagInput label="Last Names Filter" values={form.lastNames} onChange={(v) => update("lastNames", v)} />
      </div>

      <div className="space-y-3 rounded-lg border border-[var(--border)] p-4">
        <div>
          <span className="mb-2 block text-xs font-semibold text-[var(--text)]">Company Headcount Filter</span>
          <div className="flex flex-wrap gap-2">
            {COMPANY_HEADCOUNT.map((o) => (
              <ChipToggle key={o.id} label={o.label} active={form.companyHeadcount.includes(o.id)} onClick={() => toggleArray("companyHeadcount", o.id)} />
            ))}
          </div>
        </div>

        <div className="grid gap-4 pt-2 sm:grid-cols-2">
          <div>
            <span className="mb-2 block text-xs font-semibold text-[var(--text)]">Years of Experience</span>
            <div className="flex flex-wrap gap-2">
              {YEARS_MAPPING.map((o) => (
                <ChipToggle key={o.id} label={o.label} active={form.yearsOfExperienceIds.includes(o.id)} onClick={() => toggleArray("yearsOfExperienceIds", o.id)} />
              ))}
            </div>
          </div>
          <div>
            <span className="mb-2 block text-xs font-semibold text-[var(--text)]">Years at Current Comp.</span>
            <div className="flex flex-wrap gap-2">
              {YEARS_MAPPING.map((o) => (
                <ChipToggle key={o.id} label={o.label} active={form.yearsAtCurrentCompanyIds.includes(o.id)} onClick={() => toggleArray("yearsAtCurrentCompanyIds", o.id)} />
              ))}
            </div>
          </div>
        </div>

        <div className="pt-2">
          <span className="mb-2 block text-xs font-semibold text-[var(--text)]">Seniority Level Filter</span>
          <div className="flex flex-wrap gap-2">
            {SENIORITY_LEVELS.map((o) => (
              <ChipToggle key={o.id} label={o.label} active={form.seniorityLevelIds.includes(o.id)} onClick={() => toggleArray("seniorityLevelIds", o.id)} />
            ))}
          </div>
        </div>

        <div className="pt-2">
          <span className="mb-2 block text-xs font-semibold text-[var(--text)]">Function Filter</span>
          <div className="flex flex-wrap gap-2">
            {FUNCTIONS.map((o) => (
              <ChipToggle key={o.id} label={o.label} active={form.functionIds.includes(o.id)} onClick={() => toggleArray("functionIds", o.id)} />
            ))}
          </div>
        </div>
      </div>

      <button
        type="button"
        disabled={busy}
        className="btn-primary w-full"
        onClick={submit}
      >
        {busy ? "Iniciando búsqueda..." : "Extraer usando harvestapi"}
      </button>
    </div>
  );
}

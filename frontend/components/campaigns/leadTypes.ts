export type LeadRow = {
  id: string;
  profile_url: string;
  name: string | null;
  company: string | null;
  title: string | null;
  headline: string | null;
  photo_url: string | null;
  location: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  notes: string | null;
  is_blacklisted?: boolean;
};

export type CrmStatus =
  | "not_contacted"
  | "in_campaign"
  | "contacted"
  | "replied"
  | "not_accepted"
  | "blacklist"
  | "duplicate"
  | "failed";

export type EnrollmentRow = {
  id: string;
  campaign_id: string;
  lead_id: string;
  status: string;
  crm_status: CrmStatus;
  leads: LeadRow | null;
};

export const CRM_LABELS: Record<CrmStatus, string> = {
  not_contacted: "Sin contactar",
  in_campaign: "En campaña",
  contacted: "Contactado",
  replied: "Respondió",
  not_accepted: "No aceptó",
  blacklist: "Lista negra",
  duplicate: "Duplicado",
  failed: "Fallido",
};

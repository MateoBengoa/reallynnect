export type ContentPost = {
  id: string;
  content: string;
  status: string;
  scheduled_time: string | null;
  image_url: string | null;
  linkedin_activity_url?: string | null;
  account_id: string;
};

export type KeywordRule = {
  id: string;
  keyword: string;
  reply_template: string;
  rule_type: string;
  use_ai: boolean;
  account_id: string | null;
  post_id: string | null;
  dm_followup_template: string | null;
  dm_followup_use_ai: boolean;
  /** Si false, la regla no se aplica (UI: inactiva). Ausente = activa (compat). */
  is_active?: boolean;
};

export type ContentAccount = {
  id: string;
  li_display_name: string | null;
  li_photo_url?: string | null;
  li_headline?: string | null;
  connection_status?: string;
};

export type InboundEvent = {
  id: string;
  event_type: string;
  created_at: string;
  detail: Record<string, unknown> | null;
};

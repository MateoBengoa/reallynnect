-- Ampliar tipos de paso de campaña (mensaje sin re-visitar, nota de voz, respuesta, InMail).

alter table public.campaign_steps drop constraint if exists campaign_steps_step_type_check;

alter table public.campaign_steps add constraint campaign_steps_step_type_check check (step_type in (
  'visit_profile',
  'connect',
  'send_message',
  'send_message_open_profile',
  'follow',
  'like_post',
  'comment_post',
  'voice_note',
  'reply_comment',
  'inmail'
));

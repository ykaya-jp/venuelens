-- Migration: invitation recipient email + partner-venue push toggles
--
-- Two additive changes for Release C of the 2026-05-24 audit:
--
-- 1. project_invitations.invited_email  (P0-1)
--    Nullable column carrying the email the inviter typed. consumeInvitation
--    Link now refuses callers whose Supabase Auth email differs. Existing
--    rows have NULL → check is skipped for those (they expire in <= 30 days
--    by the existing TTL so the unchecked surface drains naturally).
--
-- 2. notification_preferences.notify_partner_venue_added / notify_partner_
--    venue_deleted  (P1-20, P1-21)
--    Two new boolean toggles paired with the partner_venue_added /
--    partner_venue_deleted Realtime push events. Defaults to true so members
--    who already opted into other partner notifications get these on the
--    first roll-out without an extra toggle step.

-- 1) ProjectInvitation.invited_email
ALTER TABLE "project_invitations"
  ADD COLUMN "invited_email" TEXT;

-- Optional read path: bound emails are queried per-token via the unique
-- token index already in place. No additional index is needed because every
-- consume lookup goes through `WHERE token = ?` first.

-- 2) NotificationPreference partner-venue toggles
ALTER TABLE "notification_preferences"
  ADD COLUMN "notify_partner_venue_added"   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "notify_partner_venue_deleted" BOOLEAN NOT NULL DEFAULT TRUE;

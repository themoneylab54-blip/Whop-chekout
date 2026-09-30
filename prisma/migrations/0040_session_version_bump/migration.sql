-- Session cookies issued before session versions (0038) carry no `sv` and are read as version 0,
-- the value every existing account still has: they would stay valid until they expire. One bump of
-- every account's session version ends them all once (intended: members simply sign in again, with
-- their password or with Google). Data only, no schema change.
UPDATE "AdminUser" SET "sessionVersion" = "sessionVersion" + 1;

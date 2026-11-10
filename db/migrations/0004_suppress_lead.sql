-- One call that suppresses an address, cancels its scheduled sends and moves the lead to suppressed.
-- The suppression row and the cancellations are kept even if the lead cannot be moved (a stage changed it
-- first, or it is already in a terminal status): an unsubscribe must never be rolled back by a state race.
CREATE OR REPLACE FUNCTION suppress_lead(p_lead uuid, p_email text, p_reason text)
RETURNS TABLE (suppressed int, cancelled int, moved int) LANGUAGE plpgsql AS $$
DECLARE v_status lead_status; v_s int := 0; v_c int := 0; v_m int := 0;
BEGIN
  INSERT INTO suppression (kind, value, reason, source)
  VALUES ('email', p_email::citext, p_reason, 'WF-09') ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_s = ROW_COUNT;

  UPDATE sends SET status = 'cancelled', failure = p_reason WHERE lead_id = p_lead AND status = 'scheduled';
  GET DIAGNOSTICS v_c = ROW_COUNT;

  SELECT status INTO v_status FROM leads WHERE id = p_lead FOR UPDATE;
  IF FOUND AND EXISTS (SELECT 1 FROM lead_status_transitions WHERE from_status = v_status AND to_status = 'suppressed') THEN
    BEGIN
      PERFORM transition_lead(p_lead, v_status, 'suppressed'::lead_status, p_reason, 'WF-09');
      v_m := 1;
    EXCEPTION WHEN OTHERS THEN
      v_m := 0;
    END;
  END IF;
  RETURN QUERY SELECT v_s, v_c, v_m;
END $$;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM campaign_runs
    WHERE execution_mode = 'LIVE'
    GROUP BY campaign_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Cannot enforce one LIVE launch per campaign while duplicate LIVE runs exist';
  END IF;
END
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_runs_single_live_launch
  ON campaign_runs (campaign_id)
  WHERE execution_mode = 'LIVE';

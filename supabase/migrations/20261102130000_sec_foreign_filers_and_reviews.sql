-- TSM, ASML and ARM report on Form 6-K, which the original check rejected.
ALTER TABLE public.sec_filings DROP CONSTRAINT sec_filings_form_type_check;
ALTER TABLE public.sec_filings ADD CONSTRAINT sec_filings_form_type_check
  CHECK (form_type IN ('8-K', '10-K', '10-Q', '10-K/A', '10-Q/A', '8-K/A', '6-K', '6-K/A'));

-- Filings the flagging pass rejected, so they are not re-analyzed on every run.
-- Kept apart from sec_filings, which readers see as extracts.
CREATE TABLE public.sec_filing_reviews (
  ticker TEXT NOT NULL,
  accession_number TEXT NOT NULL,
  form_type TEXT NOT NULL,
  filing_date DATE NOT NULL,
  reason TEXT,
  reviewed_on DATE NOT NULL,
  PRIMARY KEY (ticker, accession_number)
);

ALTER TABLE public.sec_filing_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sec_filing_reviews FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.sec_filing_reviews TO service_role;

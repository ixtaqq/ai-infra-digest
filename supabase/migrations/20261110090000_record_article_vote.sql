-- Records a 👍/👎 vote and bumps the article's counter in one transaction.
-- The worker used to read the counter and PATCH current + 1, so concurrent
-- votes on one article lost increments. The UPDATE below takes the row lock.
CREATE FUNCTION public.record_article_vote(p_article_id BIGINT, p_chat_id BIGINT, p_rating TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.article_validations(article_id, chat_id, rating)
    VALUES (p_article_id, p_chat_id, p_rating)
    ON CONFLICT (article_id, chat_id) DO NOTHING;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  UPDATE public.articles
    SET thumbs_up = COALESCE(thumbs_up, 0) + (p_rating = 'up')::INT,
        thumbs_down = COALESCE(thumbs_down, 0) + (p_rating = 'down')::INT
    WHERE id = p_article_id;
  RETURN TRUE;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_article_vote(BIGINT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_article_vote(BIGINT, BIGINT, TEXT) TO service_role;

# Editorial benchmark review

Start with `editorial-review-2026-10-06.json`: 50 real source excerpts, ten each from NVIDIA, AWS, Cloudflare, Google, and NASA. They were captured from the publishers' public RSS feeds. Each case retains its source URL, feed URL, publication time where supplied, capture time, and SHA-256 of the input text. All labels are pending human review. No model accuracy has been measured against this set.

The source text is a short excerpt of at most 25 words including the headline. This first set tests short-input classification and restraint when evidence is sparse. It does not establish full-article synthesis accuracy, factual accuracy of vendor claims, or representative coverage of all 68 feeds. Consumer technology and space stories provide candidate negative cases; reviewers must decide the labels. Add independently reported stories, filings, multi-company cases, and adversarial fixtures in separately identified sets before treating this as a broad release gate.

## Review the frozen inputs

Run offline status checks from the repository root with Node 22:

```powershell
npm run review:benchmark -- status benchmarks/editorial-review-2026-10-06.json
```

For each case, read `sourceText` and open `sourceUrl` to check provenance. Label only what the frozen input supports. Do not import facts from the full article into the expected answer when they are absent from the input. If the excerpt cannot support a meaningful decision, prepare a new, identified input and review it again; changing text without its hash is rejected.

Replace `review: null` with a human's completed annotation:

```json
{
  "reviewKind": "human",
  "reviewedBy": "Your actual reviewer name",
  "reviewedAt": "2026-10-06T00:00:00Z",
  "relevant": false,
  "tickers": [],
  "impact": 1,
  "supportedClaims": []
}
```

The values above illustrate the format; they are not labels for any captured case. Set the actual timestamp and judgments. Never use an agent's name or a model's judgment as human review. The metadata records an attestation; software cannot prove who did the reading.

Use this rubric, consistent with the production analysis prompt:

- `relevant`: true for a concrete AI infrastructure event involving compute, chips, networking, data-center capacity/power, training, deployment, or hyperscaler capital spending. General cloud tooling, consumer apps, gaming, and unrelated space news are false unless the excerpt establishes that connection. For benchmark predictions, use `relevanceScore >= 7` as the frozen boolean mapping; missing scores count as a missing prediction.
- `tickers`: use uppercase symbols for directly affected public companies supported by the input. Do not infer supply-chain beneficiaries from generic AI language. Private firms have no ticker; an off-topic case can still mention a public company.
- `impact`: 1–3 routine/minor, 4–6 notable but expected, 7–8 significant surprise, 9–10 exceptional market-moving evidence. Uncorroborated vendor announcements stay at 6 or below. Sparse evidence is not permission to invent a higher score.
- `supportedClaims`: concise factual propositions the input actually supports. Preserve distinctions such as announced versus shipped and a vendor's claim versus an independently measured result. An empty array is allowed when no useful factual proposition is supported.

Review borderline cases independently with a second person when possible. Freeze the agreed labels before inspecting model predictions to avoid adjusting the reference to fit the model.

## Export and evaluate

```powershell
npm run review:benchmark -- export benchmarks/editorial-review-2026-10-06.json benchmarks/editorial-reviewed-v1.json
npm run evaluate:benchmark -- benchmarks/editorial-reviewed-v1.json predictions.json
```

Export refuses pending reviews, duplicate sources/IDs, invalid metadata, changed input hashes, and an existing output path. It never overwrites an earlier reference set. Evaluation requires at least 50 reviewed cases. It rejects duplicate/unknown prediction IDs, missing cases, mismatched source hashes, and absent human claim-review metadata.

Each prediction needs `id`, `sourceTextSha256`, `relevant`, `tickers`, `impact`, `unsupportedClaims`, `claimsReviewedBy`, `claimsReviewedAt`, and `reviewKind: "human"`. The prediction's input hash must equal the review set's hash. A human must compare the generated claims with the source and annotate `unsupportedClaims`; a model-generated zero is not evidence. Record the model, prompt version, parameters, and input mapping alongside predictions. These commands only compare files; they do not call an AI provider.

Existing acceptance thresholds remain: complete coverage, relevance and exact ticker-set accuracy at least 95%, mean impact error at most 1, and zero human-annotated unsupported claims. Synthetic command tests exercise these gates but are not an editorial result.

## Capture a future candidate set

```powershell
npm run prepare:benchmark -- benchmarks/editorial-review-NEW-DATE.json
```

This command fetches public RSS only, uses request deadlines, requires 50 unique cases, and creates a new file with pending reviews. It makes no model calls and refuses to overwrite an existing file. Review changes in source mix and input dates before comparing a new set with the frozen baseline.

# Ever Ready Makeup Transfer API

This local service matches the Ever Ready app's new photoreal try-on contract.

It supports these modes:

1. `openai-direct`
   Use OpenAI `gpt-image-1` (Images Edits API) with the selfie plus inspiration image. Set `OPENAI_API_KEY` and `MAKEUP_TRANSFER_PROVIDER=openai`.
2. `gemini-direct`
   Use Gemini image generation/editing directly with the selfie plus inspiration image.
3. `upstream-proxy`
   Forward the selfie + selected look reference to a real makeup-transfer provider.
4. `mock-output`
   Return a fixed transformed image so you can test the app flow without a live provider.

Switch between OpenAI and Gemini by setting `MAKEUP_TRANSFER_PROVIDER` to `openai`, `gemini`, or `auto` (auto prefers Gemini if its key is set, otherwise OpenAI).

## Request Contract

`POST /api/makeup-transfer`

```json
{
  "look_id": "look-123",
  "look_title": "Soft Glam Glow",
  "category": "glam",
  "tip": "Sculpted skin with shimmer and a satin lip.",
  "prompt": "glam makeup look portrait full glam beauty",
  "style_traits": ["full coverage", "defined contour", "statement eyes", "elevated finish"],
  "selfie_image_base64": "...",
  "reference_image_base64": "...",
  "reference_image_url": "https://...",
  "selfie_landmarks": [{ "x": 0.5, "y": 0.5, "z": 0.0 }],
  "reference_landmarks": [{ "x": 0.5, "y": 0.5, "z": 0.0 }]
}
```

`selfie_landmarks` and `reference_landmarks` are optional, but they are the new mask-aware path.

When you provide MediaPipe Face Landmarker results with at least 468 normalized points, the server now derives:
- `inner_lips`
- `upper_eyelid_crease`
- `cheek_apples`

Those masks are injected into the real transfer pipeline as geometry guidance for Gemini and are also forwarded in proxy mode to upstream providers.

Accepted landmark payload shapes:
- raw landmark array: `[{ x, y, z }, ...]`
- `{ "landmarks": [...] }`
- `{ "faceLandmarks": [[...]] }`

## Response Contract

```json
{
  "image_base64": "...",
  "image_url": "https://..."
}
```

You only need one of `image_base64` or `image_url`.

## Run Locally

1. Copy `.env.example` to `.env`
2. Fill one of these:
   - `GOOGLE_AI_API_KEY` for direct Gemini try-on generation
   - `UPSTREAM_MAKEUP_TRANSFER_URL` for your own provider
   - `MOCK_TRANSFER_OUTPUT_PATH` for a fixed local output
   - optionally set `GOOGLE_CLOUD_PROJECT_ID` and `GOOGLE_CLOUD_STORAGE_BUCKET`
   - set `GEMINI_GENERATION_TIMEOUT_MS=90000` if you want a 90-second photoreal generation ceiling
3. Run:

```bash
node server.mjs
```

On Simulator, the app automatically tries:

`http://127.0.0.1:8788/api/makeup-transfer`

if `MAKEUP_TRANSFER_API_URL` is empty in `Info.plist`.

## Recommended Path For Realistic Results

If you want output closer to commercial try-on apps, start with `GOOGLE_AI_API_KEY`.

The backend will send:
- the user's selfie as the identity reference
- the selected Ever Ready look image as the inspiration reference
- a prompt that tells Gemini to preserve the exact person and transfer only the makeup
- optional MediaPipe-derived feature masks for lips, upper eyelid crease, and cheek apples when landmark payloads are provided

That is much closer to the class of result you're asking for than the local overlay renderer.

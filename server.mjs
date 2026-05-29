import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getFeatureMasks } from "./feature-masks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotEnv(join(__dirname, ".env"));

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8788);
const UPSTREAM_MAKEUP_TRANSFER_URL = (process.env.UPSTREAM_MAKEUP_TRANSFER_URL || "").trim();
const UPSTREAM_AUTH_TOKEN = (process.env.UPSTREAM_AUTH_TOKEN || "").trim();
const MOCK_TRANSFER_OUTPUT_PATH = (process.env.MOCK_TRANSFER_OUTPUT_PATH || "").trim();
const GOOGLE_AI_API_KEY = (process.env.GOOGLE_AI_API_KEY || "").trim();
const GOOGLE_AI_URL = (process.env.GOOGLE_AI_URL || "https://generativelanguage.googleapis.com/v1beta").trim();
const GOOGLE_CLOUD_PROJECT_ID = (process.env.GOOGLE_CLOUD_PROJECT_ID || "ever-ready-496213").trim();
const GOOGLE_CLOUD_STORAGE_BUCKET = (process.env.GOOGLE_CLOUD_STORAGE_BUCKET || "ever-ready-images").trim();
const REFERENCE_ANALYSIS_SETTING = (process.env.ENABLE_REFERENCE_ANALYSIS || "").trim().toLowerCase();
const ENABLE_REFERENCE_ANALYSIS = REFERENCE_ANALYSIS_SETTING
  ? REFERENCE_ANALYSIS_SETTING === "true"
  : Boolean(GOOGLE_AI_API_KEY);
const REFERENCE_ANALYSIS_TIMEOUT_MS = Number(process.env.REFERENCE_ANALYSIS_TIMEOUT_MS || 12000);
const GEMINI_GENERATION_TIMEOUT_MS = Number(process.env.GEMINI_GENERATION_TIMEOUT_MS || 300000);
const ENABLE_IDENTITY_RESTORATION_PASS =
  (process.env.ENABLE_IDENTITY_RESTORATION_PASS || "").trim().toLowerCase() === "true";
const GEMINI_IMAGE_TEMPERATURE = Number(process.env.GEMINI_IMAGE_TEMPERATURE || 0.5);
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_API_URL = (process.env.OPENAI_API_URL || "https://api.openai.com/v1").trim();
const OPENAI_IMAGE_MODEL = (process.env.OPENAI_IMAGE_MODEL || "gpt-image-1").trim();
const OPENAI_IMAGE_SIZE = (process.env.OPENAI_IMAGE_SIZE || "1024x1024").trim();
const OPENAI_IMAGE_QUALITY = (process.env.OPENAI_IMAGE_QUALITY || "high").trim();
const OPENAI_INPUT_FIDELITY = (process.env.OPENAI_INPUT_FIDELITY || "high").trim();
const OPENAI_GENERATION_TIMEOUT_MS = Number(process.env.OPENAI_GENERATION_TIMEOUT_MS || 180000);
const MAKEUP_TRANSFER_PROVIDER = (process.env.MAKEUP_TRANSFER_PROVIDER || "auto").trim().toLowerCase();
const transferJobs = new Map();

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

const server = createServer(async (req, res) => {
  try {
    const requestURL = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = requestURL.pathname;
    console.log(`[makeup-transfer-api] ${req.method} ${pathname}`);

    if (req.method === "OPTIONS") {
      writeJson(res, 204, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      writeJson(res, 200, {
        ok: true,
        mode: resolveMode(),
        provider: MAKEUP_TRANSFER_PROVIDER || "auto",
        hasOpenAI: Boolean(OPENAI_API_KEY),
        hasGemini: Boolean(GOOGLE_AI_API_KEY),
        hasUpstream: Boolean(UPSTREAM_MAKEUP_TRANSFER_URL),
        hasMockOutput: Boolean(MOCK_TRANSFER_OUTPUT_PATH),
        googleCloudProjectID: GOOGLE_CLOUD_PROJECT_ID || null,
        storageBucket: GOOGLE_CLOUD_STORAGE_BUCKET || null,
        openaiModel: OPENAI_API_KEY ? OPENAI_IMAGE_MODEL : null,
        openaiSize: OPENAI_API_KEY ? OPENAI_IMAGE_SIZE : null,
        openaiQuality: OPENAI_API_KEY ? OPENAI_IMAGE_QUALITY : null,
        openaiInputFidelity: OPENAI_API_KEY ? OPENAI_INPUT_FIDELITY : null,
        generationTimeoutMs: GEMINI_GENERATION_TIMEOUT_MS,
        openaiTimeoutMs: OPENAI_GENERATION_TIMEOUT_MS
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/makeup-transfer/jobs") {
      const body = await readJsonBody(req);
      const payload = buildTransferPayload(body);
      const job = createTransferJob(payload);
      processTransferJob(job.id, payload);
      writeJson(res, 202, {
        job_id: job.id,
        status: job.status
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/makeup-transfer/jobs/")) {
      const jobID = pathname.split("/").pop();
      const job = jobID ? transferJobs.get(jobID) : null;

      if (!job) {
        writeJson(res, 404, { error: "Transfer job not found." });
        return;
      }

      writeJson(res, 200, serializeTransferJob(job));
      return;
    }

    if (req.method === "POST" && pathname === "/api/makeup-transfer") {
      const body = await readJsonBody(req);
      const payload = buildTransferPayload(body);
      const result = await performTransfer(payload);
      writeJson(res, 200, result);
      return;
    }

    writeJson(res, 404, { error: "Route not found." });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    writeJson(res, statusCode, {
      error: error instanceof Error ? error.message : "Unknown server error."
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `[makeup-transfer-api] listening on http://${HOST}:${PORT} (mode: ${resolveMode()})`
  );
});

function resolveMode() {
  if (MOCK_TRANSFER_OUTPUT_PATH) return "mock-output";

  if (MAKEUP_TRANSFER_PROVIDER === "openai" && OPENAI_API_KEY) return "openai-direct";
  if (MAKEUP_TRANSFER_PROVIDER === "gemini" && GOOGLE_AI_API_KEY) return "gemini-direct";

  if (MAKEUP_TRANSFER_PROVIDER === "auto" || !MAKEUP_TRANSFER_PROVIDER) {
    if (OPENAI_API_KEY && !GOOGLE_AI_API_KEY) return "openai-direct";
    if (GOOGLE_AI_API_KEY) return "gemini-direct";
  }

  if (UPSTREAM_MAKEUP_TRANSFER_URL) return "upstream-proxy";
  return "unconfigured";
}

function buildUpstreamHeaders() {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json"
  };

  if (UPSTREAM_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${UPSTREAM_AUTH_TOKEN}`;
    headers["x-api-key"] = UPSTREAM_AUTH_TOKEN;
  }

  return headers;
}

function normalizePayload(body) {
  return {
    look_id: typeof body.look_id === "string" ? body.look_id : "",
    look_title: typeof body.look_title === "string" ? body.look_title : "",
    category: typeof body.category === "string" ? body.category : "",
    tip: typeof body.tip === "string" ? body.tip : "",
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    style_traits: Array.isArray(body.style_traits) ? body.style_traits.filter(isString) : [],
    selfie_image_base64:
      typeof body.selfie_image_base64 === "string" ? stripDataURLPrefix(body.selfie_image_base64) : "",
    reference_image_base64:
      typeof body.reference_image_base64 === "string"
        ? stripDataURLPrefix(body.reference_image_base64)
        : "",
    reference_image_url:
      typeof body.reference_image_url === "string" ? body.reference_image_url : "",
    selfie_landmarks: normalizeLandmarkPayload(body.selfie_landmarks),
    reference_landmarks: normalizeLandmarkPayload(body.reference_landmarks),
    selfie_feature_masks: normalizeFeatureMaskPayload(body.selfie_feature_masks),
    reference_feature_masks: normalizeFeatureMaskPayload(body.reference_feature_masks),
  };
}

function buildTransferPayload(body) {
  const payload = normalizePayload(body);

  return {
    ...payload,
    selfie_feature_masks: payload.selfie_feature_masks || buildFeatureMaskPayload(payload.selfie_landmarks),
    reference_feature_masks: payload.reference_feature_masks || buildFeatureMaskPayload(payload.reference_landmarks),
  };
}

function createTransferJob(payload) {
  cleanupTransferJobs();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  const job = {
    id,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    lookID: payload.look_id || "unknown",
    result: null,
    error: null
  };

  transferJobs.set(id, job);
  console.log(`[makeup-transfer-api] queued job ${id} look=${job.lookID}`);
  return job;
}

function serializeTransferJob(job) {
  return {
    job_id: job.id,
    status: job.status,
    image_base64: job.result?.image_base64 || null,
    image_url: job.result?.image_url || null,
    error: job.error || null
  };
}

async function processTransferJob(jobID, payload) {
  const job = transferJobs.get(jobID);
  if (!job) return;

  job.status = "running";
  job.updatedAt = Date.now();

  try {
    const result = await performTransfer(payload);
    job.status = "completed";
    job.result = result;
    job.updatedAt = Date.now();
    console.log(`[makeup-transfer-api] job ${jobID} completed`);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "Unknown transfer error.";
    job.updatedAt = Date.now();
    console.error(`[makeup-transfer-api] job ${jobID} failed: ${job.error}`);
  }
}

async function performTransfer(payload) {
  console.log(
    `[makeup-transfer-api] transfer request look=${payload.look_id || "unknown"} selfieBytes=${payload.selfie_image_base64?.length || 0} referenceBytes=${payload.reference_image_base64?.length || 0}`
  );

  if (MOCK_TRANSFER_OUTPUT_PATH) {
    const imagePath = resolveMockPath(MOCK_TRANSFER_OUTPUT_PATH);
    if (!existsSync(imagePath)) {
      throw new HttpError(500, `Mock output image not found at ${imagePath}.`);
    }

    const buffer = readFileSync(imagePath);
    return {
      image_base64: buffer.toString("base64")
    };
  }

  const mode = resolveMode();

  if (mode === "openai-direct") {
    const openAIResult = await generateWithOpenAI(payload);
    console.log("[makeup-transfer-api] OpenAI gpt-image-1 transfer succeeded");
    return openAIResult;
  }

  if (mode === "gemini-direct") {
    const geminiResult = await generateWithGemini(payload);
    console.log("[makeup-transfer-api] Gemini transfer succeeded");
    return geminiResult;
  }

  if (!UPSTREAM_MAKEUP_TRANSFER_URL) {
    throw new HttpError(
      501,
      "No photoreal makeup-transfer provider is configured yet. Set OPENAI_API_KEY, GOOGLE_AI_API_KEY, UPSTREAM_MAKEUP_TRANSFER_URL, or MOCK_TRANSFER_OUTPUT_PATH."
    );
  }

  const upstreamResponse = await fetch(UPSTREAM_MAKEUP_TRANSFER_URL, {
    method: "POST",
    headers: buildUpstreamHeaders(),
    body: JSON.stringify(payload)
  });

  const rawText = await upstreamResponse.text();
  if (!upstreamResponse.ok) {
    throw new HttpError(
      upstreamResponse.status,
      `Upstream makeup-transfer provider failed: ${rawText || upstreamResponse.statusText}`
    );
  }

  const json = rawText ? JSON.parse(rawText) : {};
  console.log("[makeup-transfer-api] Upstream proxy transfer succeeded");
  return normalizeUpstreamResponse(json);
}

function cleanupTransferJobs() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [jobID, job] of transferJobs.entries()) {
    if (job.updatedAt < cutoff) {
      transferJobs.delete(jobID);
    }
  }
}

async function generateWithGemini(payload) {
  if (!payload.selfie_image_base64) {
    throw new Error("selfie_image_base64 is required for Gemini transfer mode.");
  }
  if (!payload.reference_image_base64) {
    throw new Error(
      "reference_image_base64 is required for Gemini transfer mode so Ever Ready can transfer the selected inspiration faithfully."
    );
  }

  let referenceAnalysis = null;
  if (ENABLE_REFERENCE_ANALYSIS) {
    const analysisStartedAt = Date.now();
    referenceAnalysis = await withTimeout(
      analyzeReferenceMakeup(payload),
      REFERENCE_ANALYSIS_TIMEOUT_MS,
      () => {
        console.warn("[makeup-transfer-api] Reference analysis timed out; continuing without it.");
        return null;
      }
    );
    if (referenceAnalysis) {
      console.log("[makeup-transfer-api] Reference analysis", referenceAnalysis);
    }
    console.log(`[makeup-transfer-api] Reference analysis stage ${Date.now() - analysisStartedAt}ms`);
  } else {
    console.log("[makeup-transfer-api] Reference analysis skipped");
  }

  const prompt = buildGeminiPrompt(payload, referenceAnalysis);
  const transferStartedAt = Date.now();
  const transferImageData = await runGeminiImageEdit({
    parts: buildGeminiParts(prompt, payload),
    timeoutMs: GEMINI_GENERATION_TIMEOUT_MS,
    label: "transfer"
  });
  console.log(
    `[makeup-transfer-api] Gemini transfer pass stage ${Date.now() - transferStartedAt}ms`
  );

  if (!ENABLE_IDENTITY_RESTORATION_PASS) {
    return { image_base64: transferImageData };
  }

  const restorationStartedAt = Date.now();
  try {
    const restoredImageData = await runGeminiImageEdit({
      parts: buildIdentityRestorationParts({
        selfieBase64: payload.selfie_image_base64,
        transferredBase64: transferImageData
      }),
      timeoutMs: GEMINI_GENERATION_TIMEOUT_MS,
      label: "identity-restore"
    });
    console.log(
      `[makeup-transfer-api] Gemini identity-restoration stage ${Date.now() - restorationStartedAt}ms`
    );
    return { image_base64: restoredImageData };
  } catch (error) {
    console.warn(
      `[makeup-transfer-api] Identity-restoration pass failed (${error?.message || error}); returning first-pass result.`
    );
    return { image_base64: transferImageData };
  }
}

async function generateWithOpenAI(payload) {
  if (!payload.selfie_image_base64) {
    throw new Error("selfie_image_base64 is required for OpenAI transfer mode.");
  }
  if (!payload.reference_image_base64) {
    throw new Error(
      "reference_image_base64 is required for OpenAI transfer mode so the selected inspiration can drive the makeup."
    );
  }

  const prompt = buildOpenAIPrompt(payload);
  const formData = new FormData();
  formData.append("model", OPENAI_IMAGE_MODEL);
  formData.append("prompt", prompt);
  formData.append("size", OPENAI_IMAGE_SIZE);
  formData.append("quality", OPENAI_IMAGE_QUALITY);
  formData.append("input_fidelity", OPENAI_INPUT_FIDELITY);
  formData.append("n", "1");

  const selfieBlob = new Blob([Buffer.from(payload.selfie_image_base64, "base64")], {
    type: "image/jpeg"
  });
  formData.append("image[]", selfieBlob, "selfie.jpg");

  const referenceBlob = new Blob([Buffer.from(payload.reference_image_base64, "base64")], {
    type: "image/jpeg"
  });
  formData.append("image[]", referenceBlob, "reference.jpg");

  const startedAt = Date.now();
  const response = await fetchWithTimeout(
    `${OPENAI_API_URL}/images/edits`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: formData
    },
    OPENAI_GENERATION_TIMEOUT_MS
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new HttpError(
      response.status,
      `OpenAI image edit failed: ${response.status}${errorText ? ` - ${errorText.replace(/\s+/g, " ").trim()}` : ""}`
    );
  }

  const data = await response.json();
  const imageBase64 = data?.data?.[0]?.b64_json;
  if (!imageBase64) {
    throw new Error("OpenAI did not return generated image data.");
  }

  console.log(
    `[makeup-transfer-api] OpenAI image edit stage ${Date.now() - startedAt}ms size=${OPENAI_IMAGE_SIZE} quality=${OPENAI_IMAGE_QUALITY} fidelity=${OPENAI_INPUT_FIDELITY}`
  );

  return { image_base64: imageBase64 };
}

function buildOpenAIPrompt(payload) {
  const lookTitle = payload.look_title || "Makeup Try-On";
  const category = payload.category || "makeup";
  const tip = (payload.tip || "").trim();
  const tipLine = tip ? `Stylist note (soft hint, not a hard rule): ${tip}` : "";

  return [
    "Edit the first image to apply the makeup from the second image.",
    "",
    "First image = the user's photo. The person in the final result must be this exact person.",
    "Second image = the makeup reference. Only its makeup, lashes, brows, contour, blush, highlight, complexion finish, and beauty lighting are the style source — never the person, hairstyle, or background.",
    "",
    "Apply onto the user from the second image, with full fidelity:",
    "- complete eye look: shadow color and finish (matte / satin / metallic / foil), crease depth, shimmer placement, eyeliner shape and intensity (tightline / lifted / winged / smoked / graphic), lower lash line treatment, lash density and length",
    "- lip color, lip finish (matte / satin / glossy / balm), and any visible lip-line definition or overlining",
    "- complexion finish (matte / satin / dewy) and effective coverage level",
    "- blush placement, color family, and intensity",
    "- contour shape and strength on cheek hollows, jaw, and nose",
    "- highlight placement and intensity (soft / visible / specular)",
    "- brow color and shaping intensity",
    "- overall makeup intensity — if the reference is dramatic, the result is dramatic; if metallic shimmer is visible, render it as opaque reflective texture, not a faint wash; do not soften, do not normalize toward casual everyday makeup",
    "",
    "Preserve from the first image, do not pull from the second image:",
    "- exact face shape, jawline, chin, forehead, hairline",
    "- exact eye shape, eye size, eye spacing, eye color",
    "- exact nose shape, lip shape, and natural lip size (only color and finish change)",
    "- exact skin undertone, ethnicity, age",
    "- moles, freckles, scars, beauty marks, skin texture",
    "- hair, clothing, accessories, pose, head angle, framing, background",
    "",
    "Output: one photoreal edited version of the first image wearing the second image's makeup. Same crop, framing, and resolution. No collage, comparison, side-by-side, caption, watermark, border, or text.",
    "",
    `Look context: "${lookTitle}" (${category}). Category is metadata only — let the second image drive the actual visible style.`,
    tipLine
  ]
    .filter(Boolean)
    .join("\n");
}

async function runGeminiImageEdit({ parts, timeoutMs, label }) {
  const response = await fetchWithRetry(
    `${GOOGLE_AI_URL}/models/gemini-2.5-flash-image:generateContent?key=${GOOGLE_AI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          temperature: GEMINI_IMAGE_TEMPERATURE
        }
      })
    },
    0,
    timeoutMs
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw buildGeminiHttpError(response.status, errorText);
  }

  const data = await response.json();
  const imagePart = data?.candidates?.[0]?.content?.parts?.find((part) => part?.inlineData?.data);
  const imageData = imagePart?.inlineData?.data;

  if (!imageData) {
    throw new Error(`Gemini did not return image data for ${label} pass.`);
  }

  return imageData;
}

function buildIdentityRestorationParts({ selfieBase64, transferredBase64 }) {
  const prompt = [
    "You are a beauty retoucher fixing identity drift after a makeup transfer.",
    "",
    "INPUTS",
    "- Image 1 = ORIGINAL USER PHOTO (the true face).",
    "- Image 2 = MAKEUP RESULT (correct makeup, but the face shape, skin tone, or features may have drifted).",
    "",
    "TASK",
    "Edit Image 2 so the person is unmistakably the same person as in Image 1, while keeping every makeup detail from Image 2 (lip color and finish, eye shadow, liner, lashes, brows, contour, blush, highlight, complexion finish).",
    "",
    "RESTORE FROM IMAGE 1",
    "- exact face shape, jawline, chin, cheek width, forehead, hairline",
    "- exact eye shape, eye size, eye spacing, eye color",
    "- exact nose shape and width",
    "- exact lip shape and natural lip size (color/finish stays from Image 2)",
    "- exact skin undertone and ethnicity",
    "- moles, freckles, scars, beauty marks, skin texture",
    "- hair color, hairline, hair styling, accessories, clothing, pose, framing, background",
    "",
    "KEEP FROM IMAGE 2",
    "- all applied makeup: lip color and finish, eyeshadow color and finish, eyeliner shape and intensity, lash density, brow shaping, blush, contour, highlight, complexion finish, overall makeup intensity",
    "",
    "OUTPUT",
    "- one photoreal image, same crop as Image 1",
    "- no collage, no caption, no border"
  ].join("\n");

  return [
    { text: prompt },
    { text: "Image 1 — ORIGINAL USER PHOTO (restore identity from this):" },
    { inline_data: { mime_type: "image/jpeg", data: selfieBase64 } },
    { text: "Image 2 — MAKEUP RESULT (keep the makeup from this):" },
    { inline_data: { mime_type: "image/jpeg", data: transferredBase64 } }
  ];
}

async function analyzeReferenceMakeup(payload) {
  if (!payload.reference_image_base64) {
    return null;
  }

  const response = await fetchWithRetry(
    `${GOOGLE_AI_URL}/models/gemini-2.5-flash:generateContent?key=${GOOGLE_AI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: [
                  "You are a makeup reference analysis engine for a beauty try-on app.",
                  "Analyze only the visible makeup in this inspiration image.",
                  "Do not generalize. Do not invent missing features.",
                  "Return concise JSON only with these exact keys:",
                  "{",
                  "\"overall_intensity\": \"low|medium|high|editorial|unknown\",",
                  "\"complexion_finish\": \"matte|satin_matte|satin|radiant|dewy|soft_focus|unknown\",",
                  "\"skin_coverage\": \"light|medium|full|unknown\",",
                  "\"lighting_profile\": \"flat_natural|soft_studio|hard_studio|editorial_high_contrast|unknown\",",
                  "\"eyeliner_presence\": \"none|soft|defined|graphic\",",
                  "\"eyeliner_shape\": \"none|tightline|lifted|winged|smoked\",",
                  "\"eyeshadow_finish\": \"matte|satin|metallic|foil|mixed|unknown\",",
                  "\"eyeshadow_color_story\": \"neutral|rose_gold|bronze|plum_burgundy|brown_smoke|other|unknown\",",
                  "\"under_eye_definition\": \"none|soft|visible|dramatic|unknown\",",
                  "\"shimmer_level\": \"none|subtle|visible|strong\",",
                  "\"lash_drama\": \"light|defined|full|dramatic\",",
                  "\"lip_color_family\": \"nude|peach|rose|mauve|brown_nude|berry|red|coral|other\",",
                  "\"lip_tone_description\": \"very short phrase\",",
                  "\"lip_intensity\": \"soft|medium|bold\",",
                  "\"lip_finish\": \"matte|satin|glossy|balmy\",",
                  "\"lip_shape\": \"natural|softly_overlined|clearly_overlined|unknown\",",
                  "\"blush_presence\": \"none|soft|visible|strong\",",
                  "\"blush_tone\": \"neutral|peach|rose|pink|bronze|berry|other\",",
                  "\"contour_strength\": \"none|soft|defined|strong\",",
                  "\"highlight_intensity\": \"none|soft|visible|specular|unknown\",",
                  "\"notes\": \"one short sentence describing the most distinctive visible makeup characteristics\"",
                  "}",
                  "Do not generalize toward natural makeup if the reference is glamorous.",
                  "If a feature is not clearly visible, use unknown instead of softening or inventing."
                ].join(" ")
              },
              {
                inline_data: {
                  mime_type: "image/jpeg",
                  data: payload.reference_image_base64
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      })
    },
    0,
    REFERENCE_ANALYSIS_TIMEOUT_MS
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw buildGeminiHttpError(response.status, errorText);
  }

  const data = await response.json();
  const textPart = data?.candidates?.[0]?.content?.parts?.find((part) => typeof part?.text === "string")?.text;
  if (!textPart) {
    return null;
  }

  try {
    const parsed = JSON.parse(textPart);
    return {
      overall_intensity: sanitizeAnalysisValue(parsed.overall_intensity),
      complexion_finish: sanitizeAnalysisValue(parsed.complexion_finish),
      skin_coverage: sanitizeAnalysisValue(parsed.skin_coverage),
      lighting_profile: sanitizeAnalysisValue(parsed.lighting_profile),
      eyeliner_presence: sanitizeAnalysisValue(parsed.eyeliner_presence),
      eyeliner_shape: sanitizeAnalysisValue(parsed.eyeliner_shape),
      eyeshadow_finish: sanitizeAnalysisValue(parsed.eyeshadow_finish),
      eyeshadow_color_story: sanitizeAnalysisValue(parsed.eyeshadow_color_story),
      under_eye_definition: sanitizeAnalysisValue(parsed.under_eye_definition),
      shimmer_level: sanitizeAnalysisValue(parsed.shimmer_level),
      lash_drama: sanitizeAnalysisValue(parsed.lash_drama),
      lip_color_family: sanitizeAnalysisValue(parsed.lip_color_family),
      lip_tone_description: sanitizeAnalysisValue(parsed.lip_tone_description),
      lip_intensity: sanitizeAnalysisValue(parsed.lip_intensity),
      lip_finish: sanitizeAnalysisValue(parsed.lip_finish),
      lip_shape: sanitizeAnalysisValue(parsed.lip_shape),
      blush_presence: sanitizeAnalysisValue(parsed.blush_presence),
      blush_tone: sanitizeAnalysisValue(parsed.blush_tone),
      contour_strength: sanitizeAnalysisValue(parsed.contour_strength),
      highlight_intensity: sanitizeAnalysisValue(parsed.highlight_intensity),
      notes: sanitizeAnalysisValue(parsed.notes)
    };
  } catch {
    return null;
  }
}

function buildGeminiHttpError(statusCode, rawText) {
  const compactText = (rawText || "").replace(/\s+/g, " ").trim();
  const lower = compactText.toLowerCase();

  if (
    statusCode === 429 ||
    lower.includes("resource_exhausted") ||
    lower.includes("quota exceeded")
  ) {
    const retryMatch = compactText.match(/retry(?:\s+in)?\s+([0-9]+(?:\.[0-9]+)?)s/i);
    const retrySeconds = retryMatch ? Math.ceil(Number(retryMatch[1])) : null;

    let message =
      "Gemini image quota is exhausted for this API key or Google AI project. Enable billing or use a project with Gemini image-generation quota, then try again.";

    if (retrySeconds) {
      message += ` Google suggests retrying in about ${retrySeconds} seconds, but if your quota limit is 0 you will need to change the project or billing setup first.`;
    }

    return new HttpError(429, message);
  }

  return new HttpError(
    statusCode,
    `Gemini makeup transfer failed: ${statusCode}${compactText ? ` - ${compactText}` : ""}`
  );
}

function buildGeminiParts(prompt, payload) {
  const parts = [{ text: prompt }];

  parts.push({
    text: "Image 1 — USER PHOTO (this is the person whose face must remain in the output; identity, features, pose, framing, hair, clothing and background all come from this image):"
  });
  parts.push({
    inline_data: {
      mime_type: "image/jpeg",
      data: payload.selfie_image_base64
    }
  });

  if (payload.reference_image_base64) {
    parts.push({
      text: "Image 2 — MAKEUP REFERENCE (extract only the makeup styling, finish, intensity, and beauty-lighting mood from this image; do not copy this person's face, hairstyle, age, ethnicity, jawline, eye shape, lip shape, nose, or background):"
    });
    parts.push({
      inline_data: {
        mime_type: "image/jpeg",
        data: payload.reference_image_base64
      }
    });
  } else if (payload.reference_image_url) {
    parts.push({
      text: `Image 2 — MAKEUP REFERENCE URL (extract only the makeup styling from here): ${payload.reference_image_url}`
    });
  }

  return parts;
}

function buildGeminiPrompt(payload, referenceAnalysis) {
  const referenceSummary = buildReferenceVisualSummary(payload, referenceAnalysis);
  const lookTitle = payload.look_title || "Makeup Try-On";
  const tip = (payload.tip || "").trim();
  const tipLine = tip ? `Stylist note (use as a soft hint, not a hard rule): ${tip}` : "";

  return [
    "You are a professional beauty editor performing a precise, photoreal makeup transfer.",
    "",
    "INPUTS",
    "- Image 1 = USER PHOTO. The output must show this exact person.",
    "- Image 2 = MAKEUP REFERENCE. Only its makeup, finish, and beauty-lighting mood are the style source.",
    "",
    "TASK",
    "Re-render Image 1 with the makeup, lip color, eye styling, lashes, brows, contour, blush, highlight, and overall finish from Image 2 applied directly onto the user's face. The output is Image 1 wearing Image 2's makeup. The person in the output is the user from Image 1, never the model from Image 2.",
    "",
    "TRANSFER FROM IMAGE 2 (do this fully, do not soften)",
    "- eye look: shadow color and finish (matte / satin / metallic / foil), crease depth, shimmer placement, eyeliner shape and intensity (tightline / lifted / winged / smoked), lower lash line treatment, lash density and length",
    "- lip color, lip finish (matte / satin / glossy / balm), and any visible lip-line definition or overlining",
    "- complexion finish (matte / satin / dewy) and effective coverage level",
    "- blush placement, color family, and intensity",
    "- contour shape and strength on cheek hollows, jaw, and nose",
    "- highlight placement and intensity (soft / visible / specular)",
    "- brow color and shaping intensity",
    "- overall makeup intensity — if the reference is bold, the result is bold; if subtle, the result is subtle; never average to generic soft glam",
    "",
    "PRESERVE FROM IMAGE 1 (do not pull any of these from Image 2)",
    "- the user's face shape, jawline, chin, forehead, hairline",
    "- the user's eye shape, eye size, eye spacing, eye color",
    "- the user's nose shape, lip shape, and natural lip size (only the color and finish change)",
    "- the user's skin undertone, ethnicity, age",
    "- moles, freckles, scars, beauty marks, visible skin texture",
    "- hair, clothing, accessories, pose, head angle, framing, background",
    "",
    "QUALITY BAR",
    "- one photoreal edited image; same crop, framing, and resolution as Image 1",
    "- the makeup must be clearly visible at phone-screen size; do not return the original selfie unchanged or a barely-tinted version",
    "- no collage, comparison sheet, side-by-side, multiple panels, caption, watermark, border, or text",
    "- photorealistic finish, not painted, not cartoon, not filtered",
    "",
    `Look context: "${lookTitle}" (${payload.category || "makeup"}). The category is navigation metadata only — let Image 2 drive the actual visual style.`,
    tipLine,
    referenceSummary
  ]
    .filter(Boolean)
    .join("\n");
}

function buildReferenceVisualSummary(payload, referenceAnalysis) {
  const lines = [];

  if (referenceAnalysis) {
    const summaryBits = [
      referenceAnalysis.overall_intensity && `overall intensity ${referenceAnalysis.overall_intensity}`,
      referenceAnalysis.complexion_finish && `${referenceAnalysis.complexion_finish} complexion`,
      referenceAnalysis.skin_coverage && `${referenceAnalysis.skin_coverage} coverage`,
      referenceAnalysis.lighting_profile && `${referenceAnalysis.lighting_profile.replace(/_/g, " ")} lighting`,
      referenceAnalysis.eyeliner_shape && referenceAnalysis.eyeliner_shape !== "none" && `${referenceAnalysis.eyeliner_shape} liner`,
      referenceAnalysis.eyeshadow_finish && referenceAnalysis.eyeshadow_color_story &&
        `${referenceAnalysis.eyeshadow_color_story.replace(/_/g, " ")} ${referenceAnalysis.eyeshadow_finish} shadow`,
      referenceAnalysis.shimmer_level && referenceAnalysis.shimmer_level !== "none" && `${referenceAnalysis.shimmer_level} shimmer`,
      referenceAnalysis.under_eye_definition && referenceAnalysis.under_eye_definition !== "none" &&
        `${referenceAnalysis.under_eye_definition} lower lash line`,
      referenceAnalysis.lash_drama && `${referenceAnalysis.lash_drama} lashes`,
      referenceAnalysis.lip_tone_description && referenceAnalysis.lip_finish &&
        `${referenceAnalysis.lip_tone_description} ${referenceAnalysis.lip_finish} lip`,
      referenceAnalysis.lip_intensity && `${referenceAnalysis.lip_intensity} lip intensity`,
      referenceAnalysis.lip_shape && referenceAnalysis.lip_shape !== "natural" &&
        `${referenceAnalysis.lip_shape.replace(/_/g, " ")} lip line`,
      referenceAnalysis.blush_presence && referenceAnalysis.blush_presence !== "none" &&
        `${referenceAnalysis.blush_presence} ${referenceAnalysis.blush_tone || ""} blush`.trim(),
      referenceAnalysis.contour_strength && referenceAnalysis.contour_strength !== "none" &&
        `${referenceAnalysis.contour_strength} contour`,
      referenceAnalysis.highlight_intensity && referenceAnalysis.highlight_intensity !== "none" &&
        `${referenceAnalysis.highlight_intensity} highlight`
    ].filter(Boolean);

    if (summaryBits.length) {
      lines.push("Reference makeup summary (derived from Image 2 — match these exactly):");
      lines.push(`- ${summaryBits.join(", ")}`);
    }
    if (referenceAnalysis.notes) {
      lines.push(`- distinctive note: ${referenceAnalysis.notes}`);
    }
  }

  const styleTraits = Array.isArray(payload.style_traits)
    ? payload.style_traits.filter(Boolean)
    : [];
  if (styleTraits.length) {
    lines.push(`Optional style cues: ${styleTraits.join(", ")} (only apply if consistent with what is actually visible in Image 2).`);
  }

  return lines.join("\n");
}

function buildVisualAnalysisBlock(referenceAnalysis) {
  if (!referenceAnalysis) {
    return "Reference visual analysis: unavailable. Fall back to the actual reference image plus textual guidance, but still avoid generic category averaging or softening.";
  }

  return [
    "Reference visual analysis from the actual selected inspiration image:",
    `- overall_intensity: ${referenceAnalysis.overall_intensity || "unknown"}`,
    `- complexion_finish: ${referenceAnalysis.complexion_finish || "unknown"}`,
    `- skin_coverage: ${referenceAnalysis.skin_coverage || "unknown"}`,
    `- lighting_profile: ${referenceAnalysis.lighting_profile || "unknown"}`,
    `- eyeliner_presence: ${referenceAnalysis.eyeliner_presence || "unknown"}`,
    `- eyeliner_shape: ${referenceAnalysis.eyeliner_shape || "unknown"}`,
    `- eyeshadow_finish: ${referenceAnalysis.eyeshadow_finish || "unknown"}`,
    `- eyeshadow_color_story: ${referenceAnalysis.eyeshadow_color_story || "unknown"}`,
    `- under_eye_definition: ${referenceAnalysis.under_eye_definition || "unknown"}`,
    `- shimmer_level: ${referenceAnalysis.shimmer_level || "unknown"}`,
    `- lash_drama: ${referenceAnalysis.lash_drama || "unknown"}`,
    `- lip_color_family: ${referenceAnalysis.lip_color_family || "unknown"}`,
    `- lip_tone_description: ${referenceAnalysis.lip_tone_description || "unknown"}`,
    `- lip_intensity: ${referenceAnalysis.lip_intensity || "unknown"}`,
    `- lip_finish: ${referenceAnalysis.lip_finish || "unknown"}`,
    `- lip_shape: ${referenceAnalysis.lip_shape || "unknown"}`,
    `- blush_presence: ${referenceAnalysis.blush_presence || "unknown"}`,
    `- blush_tone: ${referenceAnalysis.blush_tone || "unknown"}`,
    `- contour_strength: ${referenceAnalysis.contour_strength || "unknown"}`,
    `- highlight_intensity: ${referenceAnalysis.highlight_intensity || "unknown"}`,
    `- notes: ${referenceAnalysis.notes || "none"}`,
    "This visual analysis must override broad category defaults whenever there is a conflict."
  ].join("\n");
}

function buildReferenceStyleFingerprint(payload, referenceAnalysis) {
  const text = [
    payload.look_title || "",
    payload.tip || "",
    payload.category || "",
    ...(Array.isArray(payload.style_traits) ? payload.style_traits : [])
  ]
    .join(" ")
    .toLowerCase();

  const fingerprint = {
    overall_intensity: coalesceStyleValue(referenceAnalysis?.overall_intensity, inferOverallIntensity(text, payload.category)),
    lighting_profile: coalesceStyleValue(referenceAnalysis?.lighting_profile, inferLightingProfile(text, payload.category)),
    complexion_finish: coalesceStyleValue(referenceAnalysis?.complexion_finish, inferComplexionFinish(text)),
    skin_coverage: coalesceStyleValue(referenceAnalysis?.skin_coverage, inferSkinCoverage(text, payload.category)),
    cheek_tone: coalesceStyleValue(referenceAnalysis?.blush_tone, inferCheekTone(text)),
    contour_strength: coalesceStyleValue(referenceAnalysis?.contour_strength, inferContourStrength(text, payload.category)),
    highlight_intensity: coalesceStyleValue(referenceAnalysis?.highlight_intensity, inferHighlightIntensity(text)),
    eye_intensity: coalesceStyleValue(inferEyeIntensityFromAnalysis(referenceAnalysis), inferEyeIntensity(text)),
    eyeliner_style: coalesceStyleValue(referenceAnalysis?.eyeliner_shape, inferEyelinerStyle(text)),
    eyeshadow_finish: coalesceStyleValue(referenceAnalysis?.eyeshadow_finish, inferEyeshadowFinish(text)),
    eyeshadow_color_story: coalesceStyleValue(referenceAnalysis?.eyeshadow_color_story, inferEyeshadowColorStory(text)),
    under_eye_definition: coalesceStyleValue(referenceAnalysis?.under_eye_definition, inferUnderEyeDefinition(text)),
    shimmer_level: coalesceStyleValue(referenceAnalysis?.shimmer_level, inferShimmerLevel(text)),
    lash_drama: coalesceStyleValue(referenceAnalysis?.lash_drama, inferLashDrama(text)),
    lip_intensity: coalesceStyleValue(referenceAnalysis?.lip_intensity, inferLipIntensity(text)),
    lip_finish: coalesceStyleValue(referenceAnalysis?.lip_finish, inferLipFinish(text)),
    lip_tone_family: coalesceStyleValue(referenceAnalysis?.lip_color_family, inferLipToneFamily(text)),
    lip_tone_description: coalesceStyleValue(referenceAnalysis?.lip_tone_description, inferLipToneDescription(text)),
    lip_shape: coalesceStyleValue(referenceAnalysis?.lip_shape, inferLipShape(text)),
    notes: coalesceStyleValue(referenceAnalysis?.notes)
  };

  return Object.entries(fingerprint)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
}

function buildDistinctiveInstructions(referenceFingerprint) {
  const lines = referenceFingerprint
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);

  const map = new Map(lines.map((line) => {
    const [key, ...rest] = line.split(":");
    return [key.trim(), rest.join(":").trim()];
  }));

  const lightingProfile = (map.get("lighting_profile") || "").toLowerCase();
  const complexionFinish = map.get("complexion_finish") || "balanced";
  const skinCoverage = map.get("skin_coverage") || "reference-matched";
  const contourStrength = map.get("contour_strength") || "reference-matched";
  const highlightIntensity = map.get("highlight_intensity") || "reference-matched";
  const eyeIntensity = map.get("eye_intensity") || "defined";
  const eyelinerStyle = map.get("eyeliner_style") || "soft liner";
  const eyeshadowFinish = (map.get("eyeshadow_finish") || "reference-matched shadow").toLowerCase();
  const eyeshadowColorStory = (map.get("eyeshadow_color_story") || "reference color story").toLowerCase();
  const underEyeDefinition = (map.get("under_eye_definition") || "reference under-eye depth").toLowerCase();
  const lashDrama = (map.get("lash_drama") || "noticeably defined").toLowerCase();
  const lipIntensity = map.get("lip_intensity") || "defined";
  const lipFinish = (map.get("lip_finish") || "balanced").toLowerCase();
  const lipToneDescription = map.get("lip_tone_description") || map.get("lip_tone_family") || "reference";
  const lipShape = (map.get("lip_shape") || "reference-matched fullness").toLowerCase();

  const isStudioLighting = matches(lightingProfile, ["hard_studio", "editorial_high_contrast", "editorial"]);
  const hasFoilLid = matches(eyeshadowFinish, ["foil", "metallic"]) || matches(eyeshadowColorStory, ["rose gold", "rose-gold", "gold", "champagne"]);
  const hasSmokedWing = matches(eyeshadowColorStory, ["plum", "burgundy", "charcoal", "smoke"]) || matches(underEyeDefinition, ["smoked", "dramatic", "deep"]) || matches(eyelinerStyle.toLowerCase(), ["wing", "cat"]);
  const hasDramaticLashes = matches(lashDrama, ["dramatic", "full", "voluminous", "dense"]) || matches(eyelinerStyle.toLowerCase(), ["tight", "wing", "graphic"]);
  const hasStructuralContour = matches(contourStrength.toLowerCase(), ["strong", "defined", "sculpted", "editorial"]) || isStudioLighting;
  const hasSpecularHighlight = matches(highlightIntensity.toLowerCase(), ["specular", "strong", "glossy", "glass"]) || isStudioLighting;
  const hasOverlinedLip = matches(lipShape, ["overlined", "fuller", "full", "sculpted"]);
  const hasVelvetMatteLip = matches(lipFinish, ["matte", "velvet", "liquid matte"]) || matches(String(lipToneDescription).toLowerCase(), ["mauve", "terracotta"]);

  return [
    `- lighting should read as ${map.get("lighting_profile") || "reference-matched beauty lighting"} and must not stay flat if the reference is more polished`,
    `- complexion should read as ${skinCoverage} coverage with ${complexionFinish} finish, ${contourStrength} contour, and ${highlightIntensity} highlight`,
    `- lip result must read as ${lipIntensity} with a ${map.get("lip_finish") || "balanced"} finish in the ${lipToneDescription} family and ${map.get("lip_shape") || "reference-matched"} fullness`,
    `- eye result must read as ${eyeIntensity} with ${eyelinerStyle}, ${map.get("eyeshadow_finish") || "reference-matched shadow"}, ${map.get("eyeshadow_color_story") || "reference color story"}, ${map.get("under_eye_definition") || "reference under-eye depth"}, and ${map.get("shimmer_level") || "controlled shimmer"}`,
    `- lashes should appear ${map.get("lash_drama") || "noticeably defined"}`,
    `- cheeks should read ${map.get("cheek_tone") || "reference-matched"} on a ${complexionFinish} complexion`,
    `- overall glam level should stay ${map.get("overall_intensity") || "true to the reference"} and must not be normalized down to a generic soft look`,
    isStudioLighting
      ? "- neutralize the selfie's casual ambient lighting and relight the face with a hard three-point studio beauty setup, roughly forty percent more global contrast, sharp specular highlights, and deep sculpting shadows that support the makeup intensity"
      : null,
    hasFoilLid
      ? "- render the metallic lid section as dense reflective foil across the inner two-thirds of the eyelid at fully opaque, skin-obscuring intensity, keeping the same rose-gold or warm metallic family seen in the reference"
      : null,
    hasSmokedWing
      ? "- build a deep smoked outer-v with matte plum-charcoal or burgundy depth and extend it into an elongated wing when that structure is visible in the reference"
      : null,
    hasDramaticLashes
      ? "- synthesize visibly denser three-dimensional lashes, around sixty percent fuller, and keep a matte-black liquid-liner tight-line effect when the reference supports it"
      : null,
    hasStructuralContour
      ? "- map contour onto the selfie's actual bone structure by triangulating cheek hollows, temples, jawline, and nose bridge rather than laying down a flat wash of bronzer"
      : null,
    hasSpecularHighlight
      ? "- place sharp high-shine highlights on the bridge of the nose, the tip of the nose, and the highest point of the cheekbones when the reference reads specular"
      : null,
    hasOverlinedLip || hasVelvetMatteLip
      ? "- reconstruct the lip boundary with an approximately one-and-a-half millimeter over-line when needed and render a saturated velvet-matte mauve or terracotta lip with no natural lip shine left visible"
      : null,
    map.get("notes") ? `- reference notes: ${map.get("notes")}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function shouldUseHighFidelityGlamMode(payload, referenceAnalysis) {
  const text = [
    payload.look_title || "",
    payload.tip || "",
    payload.category || "",
    ...(Array.isArray(payload.style_traits) ? payload.style_traits : []),
    referenceAnalysis?.overall_intensity || "",
    referenceAnalysis?.lighting_profile || "",
    referenceAnalysis?.eyeshadow_finish || "",
    referenceAnalysis?.shimmer_level || "",
    referenceAnalysis?.lash_drama || "",
    referenceAnalysis?.contour_strength || "",
    referenceAnalysis?.highlight_intensity || "",
    referenceAnalysis?.notes || ""
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;

  if (payload.category === "glam" || payload.category === "loud" || payload.category === "bridal") score += 1;
  if (matches(text, ["glam", "editorial", "dramatic", "bold", "bridal", "night out", "graphic", "statement", "smoked", "full coverage", "foil", "metallic"])) score += 1;
  if (referenceAnalysis?.overall_intensity === "high" || referenceAnalysis?.overall_intensity === "editorial") score += 2;
  if (referenceAnalysis?.lighting_profile === "hard_studio" || referenceAnalysis?.lighting_profile === "editorial_high_contrast") score += 1;
  if (referenceAnalysis?.shimmer_level === "strong" || referenceAnalysis?.lash_drama === "dramatic" || referenceAnalysis?.contour_strength === "strong" || referenceAnalysis?.highlight_intensity === "specular") score += 1;

  return score >= 2;
}

function buildTransferModeBlock(highFidelityGlamMode) {
  if (!highFidelityGlamMode) {
    return [
      "Reference-fidelity directives:",
      "- preserve the reference's actual finish and intensity instead of averaging to a generic look",
      "- do not invent extra drama if the reference itself is subtle",
      "- do not weaken visible reference details such as liner, contour, lip depth, or shimmer when they are clearly present"
    ].join("\n");
  }

  return [
    "High-fidelity glamour directives:",
    "- perform a structural makeup overlay, not a softened inspired-by adaptation",
    "- do not normalize the result down to casual or everyday makeup",
    "- if the output would still read as mostly bare-faced, intensify the transferred makeup until the eyes, lips, complexion finish, and contour read clearly",
    "- if the selfie has flat or casual natural lighting but the reference reads like studio or editorial beauty photography, relight the face into that same warm high-contrast beauty mood while keeping the same person and scene",
    "- when the reference reads like hard studio glamour, override ambient lighting rather than preserving it: rebuild the face with hard three-point beauty lighting, roughly forty percent more global contrast, sharp specular highlights, and deep sculpting shadows",
    "- if the reference shows full-coverage satin-matte or perfected skin, replace visible redness or casual shine with that same complexion finish while keeping believable texture",
    "- if the reference shows metallic or foil eyeshadow, render it as opaque reflective texture, not a faint shimmer wash",
    "- if the reference shows dramatic lashes, under-eye smoke, pronounced contour, or specular highlight, reproduce them visibly at similar strength",
    "- if the reference shows visibly overlined or fuller lips, match that lip architecture on the selfie instead of defaulting to the natural lip edge",
    "- if the reference lip finish is velvet or liquid matte, remove natural lip shine completely instead of leaving satin or gloss residue"
  ].join("\n");
}

function coalesceStyleValue(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

function inferLightingProfile(text, category) {
  if (matches(text, ["editorial", "studio", "flash-ready", "night out", "spotlight", "red carpet", "dramatic"])) return "hard_studio";
  if (category === "glam" || category === "loud") return "hard_studio";
  if (matches(text, ["soft glam", "bridal", "luminous"])) return "soft_studio";
  return "flat_natural";
}

function inferSkinCoverage(text, category) {
  if (matches(text, ["full coverage", "perfected", "flash-ready", "airbrushed", "glam"])) return "full";
  if (matches(text, ["soft glam", "bridal", "radiant", "polished"])) return "medium";
  if (category === "glam" || category === "loud") return "full";
  if (matches(text, ["minimal", "natural", "sheer", "barely there"])) return "light";
  return "medium";
}

function inferContourStrength(text, category) {
  if (matches(text, ["contour", "sculpted", "bronzed", "defined", "snatched", "dramatic"])) return "strong";
  if (category === "glam" || category === "loud") return "strong";
  if (matches(text, ["soft glam", "bridal"])) return "defined";
  if (matches(text, ["natural", "minimal", "barely there"])) return "soft";
  return "defined";
}

function inferHighlightIntensity(text) {
  if (matches(text, ["specular", "blinding", "wet highlight", "reflective", "luminous", "glow"])) return "specular";
  if (matches(text, ["soft glow", "subtle highlight", "matte", "velvet"])) return "soft";
  return "visible";
}

function inferEyeIntensityFromAnalysis(referenceAnalysis) {
  if (!referenceAnalysis) return "";
  if (referenceAnalysis.overall_intensity === "editorial" || referenceAnalysis.overall_intensity === "high") return "high-impact";
  if (referenceAnalysis.lash_drama === "dramatic" || referenceAnalysis.under_eye_definition === "dramatic" || referenceAnalysis.eyeliner_presence === "graphic") return "high-impact";
  if (referenceAnalysis.shimmer_level === "strong" || referenceAnalysis.eyeliner_presence === "defined") return "defined";
  return "";
}

function inferOverallIntensity(text, category) {
  if (matches(text, ["bold", "graphic", "editorial", "statement", "night out", "dramatic", "full glam", "festival"])) return "high";
  if (matches(text, ["soft", "natural", "barely there", "five-minute", "school", "workday", "office", "minimal"])) return "low";
  if (category === "loud" || category === "glam") return "high";
  if (category === "school" || category === "everyday" || category === "office_work") return "low";
  return "medium";
}

function inferComplexionFinish(text) {
  if (matches(text, ["radiant", "glow", "glowing", "luminous", "dewy", "reflective"])) return "radiant and glowy";
  if (matches(text, ["velvet", "soft focus", "blur", "satin"])) return "soft-focus satin";
  if (matches(text, ["matte", "full coverage", "perfected", "flash-ready"])) return "matte-to-soft-matte perfected";
  return "balanced skin-like";
}

function inferCheekTone(text) {
  if (matches(text, ["peach", "bronze", "warm"])) return "warm peach-bronze";
  if (matches(text, ["rose", "rosy", "pink"])) return "rosy pink";
  if (matches(text, ["champagne", "gold"])) return "soft gold-champagne warmth";
  return "neutral lifted flush";
}

function inferEyeIntensity(text) {
  if (matches(text, ["smoked", "graphic", "statement eyes", "dramatic", "deeper eye", "sharper contrast"])) return "high-impact";
  if (matches(text, ["soft shimmer", "soft glam", "gentle shimmer", "calm neutrals"])) return "soft but visible";
  if (matches(text, ["simple eyes", "natural", "barely there"])) return "minimal";
  return "medium definition";
}

function inferEyelinerStyle(text) {
  if (matches(text, ["graphic", "wing", "clean liner", "wing detail", "sharper", "defined eye"])) return "visible winged or sharply defined liner";
  if (matches(text, ["soft", "smokier", "smoked"])) return "diffused liner with outer lift";
  return "subtle lifted liner";
}

function inferShimmerLevel(text) {
  if (matches(text, ["foil", "foiled", "metallic", "reflective shimmer"])) return "strong";
  if (matches(text, ["shimmer", "sparkle", "glossed", "reflective", "champagne", "gold", "soft gold"])) return "visible shimmer on the lid or inner eye";
  if (matches(text, ["matte", "muted"])) return "minimal shimmer";
  return "controlled highlight shimmer";
}

function inferLashDrama(text) {
  if (matches(text, ["lash drama", "elevated lashes", "full glam", "statement eyes", "dramatic"])) return "full and dramatic";
  if (matches(text, ["soft lashes", "natural mascara", "clean lashes"])) return "light and separated";
  return "noticeably lifted and defined";
}

function inferLipIntensity(text) {
  if (matches(text, ["statement lip", "stronger lip", "deeper lip", "bold lipstick", "cherry", "editorial"])) return "bold";
  if (matches(text, ["glossy lip", "satin lip", "easy lip", "lip balm", "tint", "soft peach lip"])) return "soft-to-medium";
  return "medium";
}

function inferLipFinish(text) {
  if (matches(text, ["gloss", "glossy", "balm shine"])) return "glossy";
  if (matches(text, ["matte", "velvet", "liquid lipstick"])) return "matte velvet";
  if (matches(text, ["satin"])) return "satin";
  return "natural satin";
}

function inferLipToneFamily(text) {
  if (matches(text, ["peach", "peachy"])) return "peach nude";
  if (matches(text, ["rose", "rosy", "pink"])) return "rose pink";
  if (matches(text, ["bronze", "warm", "caramel"])) return "warm nude bronze";
  if (matches(text, ["cherry", "berry", "red"])) return "deeper berry-red";
  return "reference-matched nude";
}

function inferLipToneDescription(text) {
  if (matches(text, ["terracotta", "mauve"])) return "deep terracotta-mauve";
  if (matches(text, ["rose", "rosy"])) return "muted rose";
  if (matches(text, ["peach"])) return "soft peach nude";
  if (matches(text, ["bronze", "warm", "brown nude"])) return "warm brown nude";
  if (matches(text, ["berry", "red"])) return "deeper berry-red";
  return "reference-matched nude";
}

function inferLipShape(text) {
  if (matches(text, ["overline", "overlined", "fuller lips", "sculpted lip"])) return "clearly_overlined";
  if (matches(text, ["soft lip edge", "defined lip"])) return "softly_overlined";
  return "natural";
}

function inferEyeshadowFinish(text) {
  if (matches(text, ["foil", "foiled"])) return "foil";
  if (matches(text, ["metallic", "rose gold", "champagne shimmer", "sparkle"])) return "metallic";
  if (matches(text, ["shimmer", "satin"])) return "mixed";
  if (matches(text, ["matte", "smoky", "smoked"])) return "matte";
  return "mixed";
}

function inferEyeshadowColorStory(text) {
  if (matches(text, ["rose gold"])) return "rose_gold";
  if (matches(text, ["plum", "burgundy", "wine"])) return "plum_burgundy";
  if (matches(text, ["bronze", "warm brown", "caramel"])) return "bronze";
  if (matches(text, ["smoke", "smoky", "brown smoke"])) return "brown_smoke";
  return "neutral";
}

function inferUnderEyeDefinition(text) {
  if (matches(text, ["smoked lower lash line", "under-eye smoke", "dramatic lower lash line"])) return "dramatic";
  if (matches(text, ["smoked", "smoky", "deepened lower lash line"])) return "visible";
  if (matches(text, ["soft lower lash line"])) return "soft";
  return "visible";
}

function matches(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function sanitizeAnalysisValue(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function normalizeUpstreamResponse(json) {
  const imageURL = findFirstMatchingString(
    json,
    ["image_url", "output_url", "result_url", "url", "output", "image", "data"],
    (value) => /^https?:\/\//i.test(value.trim())
  );
  const imageBase64 = findFirstMatchingString(
    json,
    ["image_base64", "base64", "image", "data", "output"],
    (value) => {
      const trimmed = value.trim();
      if (/^https?:\/\//i.test(trimmed)) return false;
      const normalized = trimmed.startsWith("data:") ? stripDataURLPrefix(trimmed) : trimmed;
      return normalized.length > 100 && isLikelyBase64(normalized);
    }
  );

  if (imageBase64 || imageURL) {
    return {
      image_base64: imageBase64 ? stripDataURLPrefix(imageBase64) : null,
      image_url: imageURL || null
    };
  }

  throw new Error("Upstream response did not include any supported image field (image_url, output_url, result_url, url, output, image, base64, data).");
}

function findFirstMatchingString(value, keys, predicate, path = "$") {
  const keySet = new Set(keys.map((key) => key.toLowerCase()));

  return searchMatchingString(value, keySet, predicate, path)?.value || null;
}

function searchMatchingString(value, keySet, predicate, path) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = searchMatchingString(value[index], keySet, predicate, `${path}[${index}]`);
      if (nested) return nested;
    }
    return null;
  }

  if (value && typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value)) {
      const nestedPath = `${path}.${key}`;
      if (keySet.has(key.toLowerCase())) {
        const direct = extractStringFromValue(nestedValue, predicate, nestedPath);
        if (direct) return direct;
      }

      const nested = searchMatchingString(nestedValue, keySet, predicate, nestedPath);
      if (nested) return nested;
    }
  }

  return null;
}

function extractStringFromValue(value, predicate, path) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return predicate(trimmed) ? { path, value: trimmed } : null;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = extractStringFromValue(value[index], predicate, `${path}[${index}]`);
      if (nested) return nested;
    }
    return null;
  }

  if (value && typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value)) {
      const nested = extractStringFromValue(nestedValue, predicate, `${path}.${key}`);
      if (nested) return nested;
    }
  }

  return null;
}

function isLikelyBase64(value) {
  try {
    return Buffer.from(value, "base64").toString("base64").slice(0, 32) === value.replace(/\s+/g, "").slice(0, 32);
  } catch {
    return false;
  }
}

function normalizeLandmarkPayload(value) {
  if (Array.isArray(value)) {
    return normalizeLandmarkArray(value);
  }

  if (Array.isArray(value?.faceLandmarks?.[0])) {
    return normalizeLandmarkArray(value.faceLandmarks[0]);
  }

  if (Array.isArray(value?.landmarks)) {
    return normalizeLandmarkArray(value.landmarks);
  }

  return null;
}

function normalizeLandmarkArray(value) {
  const normalized = value
    .map((point) => normalizeLandmarkPoint(point))
    .filter(Boolean);

  return normalized.length >= 468 ? normalized : null;
}

function normalizeFeatureMaskPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value;
}

function normalizeLandmarkPoint(point) {
  if (!point || typeof point !== "object") {
    return null;
  }

  const x = Number(point.x);
  const y = Number(point.y);
  const z = Number(point.z ?? 0);

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }

  return { x, y, z };
}

function buildFeatureMaskPayload(landmarks) {
  if (!landmarks) {
    return null;
  }

  try {
    const masks = getFeatureMasks(landmarks);

    return {
      source: "mediapipe-face-landmarker",
      inner_lips: {
        svg_path: masks.inner_lips.svgPath,
        bounds: boundsForPoints(masks.inner_lips.points),
      },
      upper_eyelid_crease: {
        svg_path: masks.upper_eyelid_crease.svgPath,
        left: {
          svg_path: masks.upper_eyelid_crease.left.svgPath,
          bounds: boundsForPoints(masks.upper_eyelid_crease.left.points),
        },
        right: {
          svg_path: masks.upper_eyelid_crease.right.svgPath,
          bounds: boundsForPoints(masks.upper_eyelid_crease.right.points),
        },
      },
      cheek_apples: {
        svg_path: masks.cheek_apples.svgPath,
        left: simplifyCheekMask(masks.cheek_apples.left),
        right: simplifyCheekMask(masks.cheek_apples.right),
      },
    };
  } catch {
    return null;
  }
}

function simplifyCheekMask(mask) {
  return {
    svg_path: mask.svgPath,
    center: roundPoint(mask.center),
    radii: roundPoint(mask.radii),
    rotation: roundNumber(mask.rotation),
  };
}

function buildFeatureMaskGuidance(payload) {
  if (!payload.selfie_feature_masks && !payload.reference_feature_masks) {
    return "";
  }

  const blocks = [
    "MediaPipe feature geometry guidance:",
    "- Use selfie masks as the destination placement regions.",
    "- Use reference masks as the style extraction regions for lip tone, lid intensity, crease depth, shimmer, and cheek flush placement.",
    "- Keep lip color inside inner_lips, preserve lip lines, and avoid coloring surrounding skin.",
    "- Map eyeshadow, shimmer, and liner lift to upper_eyelid_crease instead of the full eye socket.",
    "- Keep blush and highlight centered on cheek_apples with soft, feathered falloff beyond the mask edges.",
  ];

  if (payload.selfie_feature_masks) {
    blocks.push(`Selfie masks JSON: ${JSON.stringify(payload.selfie_feature_masks)}`);
  }

  if (payload.reference_feature_masks) {
    blocks.push(`Reference masks JSON: ${JSON.stringify(payload.reference_feature_masks)}`);
  }

  return blocks.join("\n");
}

function boundsForPoints(points) {
  if (!Array.isArray(points) || !points.length) {
    return null;
  }

  const bounds = points.reduce(
    (accumulator, point) => ({
      minX: Math.min(accumulator.minX, point.x),
      minY: Math.min(accumulator.minY, point.y),
      maxX: Math.max(accumulator.maxX, point.x),
      maxY: Math.max(accumulator.maxY, point.y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    }
  );

  return {
    minX: roundNumber(bounds.minX),
    minY: roundNumber(bounds.minY),
    maxX: roundNumber(bounds.maxX),
    maxY: roundNumber(bounds.maxY),
  };
}

function roundPoint(point) {
  return Object.fromEntries(
    Object.entries(point).map(([key, value]) => [key, roundNumber(value)])
  );
}

function roundNumber(value) {
  return Number(value.toFixed(6));
}

function resolveMockPath(value) {
  if (value.startsWith("/")) return value;
  return join(__dirname, value);
}

function stripDataURLPrefix(value) {
  const commaIndex = value.indexOf(",");
  if (commaIndex !== -1 && value.slice(0, commaIndex).includes("base64")) {
    return value.slice(commaIndex + 1);
  }

  return value;
}

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(statusCode === 204 ? "" : JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", reject);
  });
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;

  const contents = readFileSync(filePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function fetchWithRetry(input, init, attempt = 0, timeoutMs = 45000) {
  const response = await fetchWithTimeout(input, init, timeoutMs);
  if (response.ok || response.status < 500 || attempt >= 1) {
    return response;
  }

  await new Promise((resolve) => setTimeout(resolve, 900 * (attempt + 1)));
  return fetchWithRetry(input, init, attempt + 1, timeoutMs);
}

async function fetchWithTimeout(input, init, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new HttpError(
        504,
        `Gemini generation timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function withTimeout(promise, timeoutMs, onTimeout) {
  let timeoutId;

  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          resolve(typeof onTimeout === "function" ? onTimeout() : null);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

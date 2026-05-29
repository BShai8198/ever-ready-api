import type { IncomingMessage, ServerResponse } from "node:http";
import Replicate from "replicate";

type FetchLike = typeof fetch;

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const DEFAULT_REPLICATE_MODEL = "zsxkib/instant-id";
const DEFAULT_NEGATIVE_PROMPT =
  "cgi, render, 3d, deformed, bad anatomy, blurry, digital painting, worst quality, altered features, cartoon";
const HEX_COLOR_PATTERN = /^#?[0-9a-f]{6}$/i;

export interface BeautyTryOnRequestBody {
  selfieUrl: string;
  inspoImageUrl: string;
  catalogLimit?: number;
  replicateModel?: string;
}

export interface BeautyTryOnResponse {
  generatedImageUrl: string;
  recommendedProducts: RecommendedProduct[];
}

export interface RecommendedProduct {
  category: CosmeticCategory;
  brandName: string;
  productLine: string;
  shadeName: string;
  finish: string;
  hexCode: string;
  undertoneTags: string[];
  url: string;
  score?: number;
}

export interface BeautyTryOnRouteOptions {
  geminiApiKey: string;
  replicateApiToken: string;
  productCatalog: BeautyProductCatalog;
  geminiModel?: string;
  replicateModel?: string;
  fetchImpl?: FetchLike;
}

export interface BeautyProductCatalog {
  matchProducts(query: ProductMatchQuery): Promise<RecommendedProduct[]>;
}

type CosmeticCategory = "lip" | "eyeshadow" | "blush" | "eyeliner";
type SkinUndertone = "warm" | "cool" | "neutral" | "olive";

interface ProductMatchQuery {
  lookAnalysis: MakeupInspirationAnalysis;
  limit: number;
}

interface MakeupInspirationAnalysis {
  makeupStyleName: string;
  skinUndertone: {
    primary: SkinUndertone;
    confidence: number;
    reasoning: string;
  };
  lip: {
    colorName: string;
    finish: string;
    hexCode: string;
  };
  eyeshadow: {
    style: string;
    colors: Array<{
      name: string;
      hexCode: string;
      placement: string;
    }>;
  };
  blush: {
    colorName: string;
    hexCode: string;
    placement: string;
  };
  eyeliner: {
    style: string;
    colorName: string;
  };
}

interface ProductSearchTarget {
  category: CosmeticCategory;
  hexCode: string;
  finish: string;
  placement?: string;
  undertone: SkinUndertone;
}

export class InMemoryBeautyProductCatalog implements BeautyProductCatalog {
  constructor(private readonly products: RecommendedProduct[]) {}

  async matchProducts(query: ProductMatchQuery): Promise<RecommendedProduct[]> {
    const targets = buildProductTargets(query.lookAnalysis);
    const recommendations: RecommendedProduct[] = [];
    const seen = new Set<string>();

    for (const target of targets) {
      const bestMatches = this.products
        .filter((product) => product.category === target.category)
        .map((product) => ({
          product,
          score: scoreProductMatch(product, target),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, 2);

      for (const entry of bestMatches) {
        const key = `${entry.product.brandName}:${entry.product.productLine}:${entry.product.shadeName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        recommendations.push({
          ...entry.product,
          score: Number(entry.score.toFixed(3)),
        });
      }
    }

    return recommendations.slice(0, query.limit);
  }
}

/**
 * Factory for a Node.js route handler.
 *
 * Example:
 * const handler = createBeautyTryOnHandler({
 *   geminiApiKey: process.env.GEMINI_API_KEY!,
 *   replicateApiToken: process.env.REPLICATE_API_TOKEN!,
 *   productCatalog: new InMemoryBeautyProductCatalog(seedProducts),
 * });
 */
export function createBeautyTryOnHandler(options: BeautyTryOnRouteOptions) {
  assertConfigured(options.geminiApiKey, "geminiApiKey");
  assertConfigured(options.replicateApiToken, "replicateApiToken");

  const resolvedOptions: Required<Omit<BeautyTryOnRouteOptions, "productCatalog">> & Pick<BeautyTryOnRouteOptions, "productCatalog"> = {
    geminiApiKey: options.geminiApiKey,
    replicateApiToken: options.replicateApiToken,
    productCatalog: options.productCatalog,
    geminiModel: options.geminiModel || DEFAULT_GEMINI_MODEL,
    replicateModel: options.replicateModel || DEFAULT_REPLICATE_MODEL,
    fetchImpl: options.fetchImpl || fetch,
  };

  return async function handleBeautyTryOnRequest(req: IncomingMessage, res: ServerResponse) {
    try {
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "Method not allowed. Use POST." });
        return;
      }

      const body = normalizeTryOnRequest(await readJsonBody(req));
      const result = await runBeautyTryOnPipeline(body, resolvedOptions);
      writeJson(res, 200, result);
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      writeJson(res, statusCode, {
        error: error instanceof Error ? error.message : "Unknown beauty try-on error.",
      });
    }
  };
}

export async function runBeautyTryOnPipeline(
  request: BeautyTryOnRequestBody,
  options: BeautyTryOnRouteOptions,
): Promise<BeautyTryOnResponse> {
  assertConfigured(options.geminiApiKey, "geminiApiKey");
  assertConfigured(options.replicateApiToken, "replicateApiToken");

  const normalizedRequest = normalizeTryOnRequest(request);
  const fetchImpl = options.fetchImpl || fetch;

  const analysis = await analyzeInspoImage(normalizedRequest.inspoImageUrl, {
    geminiApiKey: options.geminiApiKey,
    geminiModel: options.geminiModel || DEFAULT_GEMINI_MODEL,
    fetchImpl,
  });

  const [recommendedProducts, generatedImageUrl] = await Promise.all([
    options.productCatalog.matchProducts({
      lookAnalysis: analysis,
      limit: normalizedRequest.catalogLimit || 8,
    }),
    generateIdentityPreservingTryOn(
      {
        selfieUrl: normalizedRequest.selfieUrl,
        analysis,
        replicateModel: normalizedRequest.replicateModel || options.replicateModel || DEFAULT_REPLICATE_MODEL,
      },
      options.replicateApiToken,
    ),
  ]);

  return {
    generatedImageUrl,
    recommendedProducts,
  };
}

async function analyzeInspoImage(
  inspoImageUrl: string,
  options: {
    geminiApiKey: string;
    geminiModel: string;
    fetchImpl: FetchLike;
  },
): Promise<MakeupInspirationAnalysis> {
  const imagePart = await downloadImageAsInlinePart(inspoImageUrl, options.fetchImpl);
  const prompt = [
    "You are a beauty-vision analyst.",
    "Analyze only the makeup inspiration image and return strict JSON.",
    "Identify the skin undertone, makeup style name, and explicit cosmetic breakdown.",
    "Be concrete and visual rather than aspirational.",
    "If a color is approximate, still return the closest usable six-digit hex code.",
  ].join(" ");

  const response = await options.fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${options.geminiModel}:generateContent?key=${options.geminiApiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              imagePart,
            ],
          },
        ],
        generationConfig: {
          response_mime_type: "application/json",
          response_json_schema: LOOK_ANALYSIS_RESPONSE_SCHEMA,
          temperature: 0.1,
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new HttpError(
      502,
      `Gemini vision extraction failed (${response.status}): ${errorText || response.statusText}`,
    );
  }

  const payload = await response.json();
  const text = extractGeminiText(payload);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new HttpError(
      502,
      `Gemini returned non-JSON analysis output: ${error instanceof Error ? error.message : "Unknown parse error."}`,
    );
  }

  return sanitizeLookAnalysis(parsed);
}

async function generateIdentityPreservingTryOn(
  input: {
    selfieUrl: string;
    analysis: MakeupInspirationAnalysis;
    replicateModel: string;
  },
  replicateApiToken: string,
): Promise<string> {
  const replicate = new Replicate({
    auth: replicateApiToken,
  });

  const prompt = buildIdentityPreservingPrompt(input.analysis);
  const output = await replicate.run(input.replicateModel, {
    input: {
      face_image: input.selfieUrl,
      prompt,
      negative_prompt: DEFAULT_NEGATIVE_PROMPT,
      ip_adapter_scale: 0.8,
      controlnet_conditioning_scale: 0.8,
    },
  });

  return extractGeneratedImageUrl(output);
}

function buildIdentityPreservingPrompt(analysis: MakeupInspirationAnalysis): string {
  const lidColors = analysis.eyeshadow.colors.map((entry) => `${entry.name} ${entry.hexCode}`).join(", ");
  const blushPlacement = analysis.blush.placement.toLowerCase();

  return [
    "High-resolution portrait of the same woman from the source selfie.",
    `Preserve facial identity, face geometry, nose, lips, eyes, hairline, and background.`,
    `${analysis.makeupStyleName} editorial makeup application.`,
    `${analysis.lip.colorName} ${analysis.lip.finish} lipstick in ${analysis.lip.hexCode}.`,
    `${analysis.eyeshadow.style} eyeshadow using ${lidColors}.`,
    `${analysis.blush.colorName} blush placed ${blushPlacement}.`,
    `${analysis.eyeliner.style} eyeliner in ${analysis.eyeliner.colorName}.`,
    `Skin undertone harmony should stay ${analysis.skinUndertone.primary}.`,
    "Flawless but realistic skin texture, photorealistic, 8k, beauty shot.",
  ].join(" ");
}

function buildProductTargets(analysis: MakeupInspirationAnalysis): ProductSearchTarget[] {
  const primaryLidColor = analysis.eyeshadow.colors[0]?.hexCode || "#8B6C64";
  const secondaryLidColor = analysis.eyeshadow.colors[1]?.hexCode || primaryLidColor;

  return [
    {
      category: "lip",
      hexCode: analysis.lip.hexCode,
      finish: analysis.lip.finish,
      undertone: analysis.skinUndertone.primary,
    },
    {
      category: "eyeshadow",
      hexCode: primaryLidColor,
      finish: analysis.eyeshadow.style,
      undertone: analysis.skinUndertone.primary,
    },
    {
      category: "eyeshadow",
      hexCode: secondaryLidColor,
      finish: analysis.eyeshadow.style,
      undertone: analysis.skinUndertone.primary,
    },
    {
      category: "blush",
      hexCode: analysis.blush.hexCode,
      finish: "powder",
      placement: analysis.blush.placement,
      undertone: analysis.skinUndertone.primary,
    },
    {
      category: "eyeliner",
      hexCode: "#1E1A19",
      finish: analysis.eyeliner.style,
      undertone: analysis.skinUndertone.primary,
    },
  ];
}

function scoreProductMatch(product: RecommendedProduct, target: ProductSearchTarget): number {
  const finishMatch = normalizeString(product.finish).includes(normalizeString(target.finish)) ||
    normalizeString(target.finish).includes(normalizeString(product.finish));
  const undertoneMatch = product.undertoneTags
    .map(normalizeString)
    .includes(normalizeString(target.undertone));
  const placementBoost = target.placement && normalizeString(target.placement).includes("high")
    ? 0.02
    : 0;

  return (
    scoreHexDistance(product.hexCode, target.hexCode) * 0.6 +
    (finishMatch ? 0.22 : 0) +
    (undertoneMatch ? 0.16 : 0) +
    placementBoost
  );
}

function scoreHexDistance(leftHex: string, rightHex: string): number {
  const left = hexToRgb(leftHex);
  const right = hexToRgb(rightHex);
  const distance = Math.sqrt(
    Math.pow(left.r - right.r, 2) +
      Math.pow(left.g - right.g, 2) +
      Math.pow(left.b - right.b, 2),
  );

  return Math.max(0, 1 - distance / 441.67295593);
}

async function downloadImageAsInlinePart(url: string, fetchImpl: FetchLike) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    const errorText = await response.text();
    throw new HttpError(
      400,
      `Unable to download inspiration image (${response.status}): ${errorText || response.statusText}`,
    );
  }

  const contentType = response.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await response.arrayBuffer());

  return {
    inline_data: {
      mime_type: contentType,
      data: buffer.toString("base64"),
    },
  };
}

function extractGeminiText(payload: any): string {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    throw new HttpError(502, "Gemini response did not contain any content parts.");
  }

  const combined = parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();

  if (!combined) {
    throw new HttpError(502, "Gemini returned an empty analysis response.");
  }

  return combined;
}

function extractGeneratedImageUrl(output: unknown): string {
  const candidate = extractFirstOutputCandidate(output);

  if (typeof candidate === "string" && candidate.trim()) {
    return candidate;
  }

  if (candidate && typeof candidate === "object") {
    const fileCandidate = candidate as { url?: string | (() => string | URL) };

    if (typeof fileCandidate.url === "function") {
      return String(fileCandidate.url());
    }

    if (typeof fileCandidate.url === "string" && fileCandidate.url.trim()) {
      return fileCandidate.url;
    }
  }

  throw new HttpError(502, "Replicate did not return a generated image URL.");
}

function extractFirstOutputCandidate(output: unknown): unknown {
  if (Array.isArray(output)) {
    return output[0];
  }

  return output;
}

function sanitizeLookAnalysis(input: unknown): MakeupInspirationAnalysis {
  if (!isRecord(input)) {
    throw new HttpError(502, "Gemini analysis response was not an object.");
  }

  const skinUndertone = sanitizeUndertone(input.skinUndertone);
  const makeupStyleName = sanitizeModelString(input.makeupStyleName, "makeupStyleName");
  const lip = sanitizeLipAnalysis(input.lip);
  const eyeshadow = sanitizeEyeshadowAnalysis(input.eyeshadow);
  const blush = sanitizeBlushAnalysis(input.blush);
  const eyeliner = sanitizeEyelinerAnalysis(input.eyeliner);

  return {
    makeupStyleName,
    skinUndertone,
    lip,
    eyeshadow,
    blush,
    eyeliner,
  };
}

function sanitizeUndertone(input: unknown): MakeupInspirationAnalysis["skinUndertone"] {
  if (!isRecord(input)) {
    throw new HttpError(502, "Gemini analysis missing skinUndertone object.");
  }

  const primary = sanitizeUndertoneValue(input.primary);
  const confidence = clampNumber(input.confidence, 0, 1, 0.65);
  const reasoning = sanitizeModelString(input.reasoning, "skinUndertone.reasoning");

  return { primary, confidence, reasoning };
}

function sanitizeLipAnalysis(input: unknown): MakeupInspirationAnalysis["lip"] {
  if (!isRecord(input)) {
    throw new HttpError(502, "Gemini analysis missing lip object.");
  }

  return {
    colorName: sanitizeModelString(input.colorName, "lip.colorName"),
    finish: sanitizeModelString(input.finish, "lip.finish"),
    hexCode: sanitizeHex(input.hexCode, "lip.hexCode"),
  };
}

function sanitizeEyeshadowAnalysis(input: unknown): MakeupInspirationAnalysis["eyeshadow"] {
  if (!isRecord(input)) {
    throw new HttpError(502, "Gemini analysis missing eyeshadow object.");
  }

  const colors = Array.isArray(input.colors) ? input.colors : [];
  if (!colors.length) {
    throw new HttpError(502, "Gemini analysis missing eyeshadow.colors entries.");
  }

  return {
    style: sanitizeModelString(input.style, "eyeshadow.style"),
    colors: colors.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new HttpError(502, `Gemini eyeshadow.colors[${index}] was not an object.`);
      }

      return {
        name: sanitizeModelString(entry.name, `eyeshadow.colors[${index}].name`),
        hexCode: sanitizeHex(entry.hexCode, `eyeshadow.colors[${index}].hexCode`),
        placement: sanitizeModelString(entry.placement, `eyeshadow.colors[${index}].placement`),
      };
    }),
  };
}

function sanitizeBlushAnalysis(input: unknown): MakeupInspirationAnalysis["blush"] {
  if (!isRecord(input)) {
    throw new HttpError(502, "Gemini analysis missing blush object.");
  }

  return {
    colorName: sanitizeModelString(input.colorName, "blush.colorName"),
    hexCode: sanitizeHex(input.hexCode, "blush.hexCode"),
    placement: sanitizeModelString(input.placement, "blush.placement"),
  };
}

function sanitizeEyelinerAnalysis(input: unknown): MakeupInspirationAnalysis["eyeliner"] {
  if (!isRecord(input)) {
    throw new HttpError(502, "Gemini analysis missing eyeliner object.");
  }

  return {
    style: sanitizeModelString(input.style, "eyeliner.style"),
    colorName: sanitizeModelString(input.colorName, "eyeliner.colorName"),
  };
}

function normalizeTryOnRequest(input: unknown): BeautyTryOnRequestBody {
  if (!isRecord(input)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }

  const selfieUrl = sanitizeUrl(input.selfieUrl ?? input.selfie, "selfieUrl");
  const inspoImageUrl = sanitizeUrl(input.inspoImageUrl ?? input.inspoImage, "inspoImageUrl");
  const catalogLimit = clampNumber(input.catalogLimit, 1, 20, 8);
  const replicateModel = typeof input.replicateModel === "string" ? input.replicateModel.trim() : undefined;

  return {
    selfieUrl,
    inspoImageUrl,
    catalogLimit,
    replicateModel,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new HttpError(400, "Request body cannot be empty.");
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new HttpError(
      400,
      `Request body must be valid JSON: ${error instanceof Error ? error.message : "Unknown parse error."}`,
    );
  }
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown) {
  const body = JSON.stringify(payload, null, 2);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.end(body);
}

function sanitizeUrl(input: unknown, fieldName: string): string {
  const value = sanitizeRequestString(input, fieldName);

  try {
    return new URL(value).toString();
  } catch {
    throw new HttpError(400, `${fieldName} must be a valid absolute URL.`);
  }
}

function sanitizeRequestString(input: unknown, fieldName: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new HttpError(400, `${fieldName} is required.`);
  }

  return input.trim();
}

function sanitizeModelString(input: unknown, fieldName: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new HttpError(502, `${fieldName} was missing from Gemini analysis output.`);
  }

  return input.trim();
}

function sanitizeHex(input: unknown, fieldName: string): string {
  const value = sanitizeModelString(input, fieldName);
  if (!HEX_COLOR_PATTERN.test(value)) {
    throw new HttpError(502, `${fieldName} must be a six-digit hex code.`);
  }

  return value.startsWith("#") ? value.toUpperCase() : `#${value.toUpperCase()}`;
}

function sanitizeUndertoneValue(input: unknown): SkinUndertone {
  const value = sanitizeModelString(input, "skinUndertone.primary").toLowerCase();
  if (value === "warm" || value === "cool" || value === "neutral" || value === "olive") {
    return value;
  }

  throw new HttpError(502, `Unsupported undertone value "${value}".`);
}

function clampNumber(input: unknown, min: number, max: number, fallback: number): number {
  const value = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeString(value: string): string {
  return value.trim().toLowerCase();
}

function assertConfigured(value: string, fieldName: string) {
  if (!value.trim()) {
    throw new HttpError(500, `Missing required backend configuration: ${fieldName}.`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hexToRgb(hexCode: string) {
  const normalized = hexCode.replace("#", "");
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

const LOOK_ANALYSIS_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    makeupStyleName: {
      type: "string",
    },
    skinUndertone: {
      type: "object",
      properties: {
        primary: {
          type: "string",
          enum: ["warm", "cool", "neutral", "olive"],
        },
        confidence: {
          type: "number",
        },
        reasoning: {
          type: "string",
        },
      },
      required: ["primary", "confidence", "reasoning"],
    },
    lip: {
      type: "object",
      properties: {
        colorName: { type: "string" },
        finish: { type: "string" },
        hexCode: { type: "string" },
      },
      required: ["colorName", "finish", "hexCode"],
    },
    eyeshadow: {
      type: "object",
      properties: {
        style: { type: "string" },
        colors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              hexCode: { type: "string" },
              placement: { type: "string" },
            },
            required: ["name", "hexCode", "placement"],
          },
        },
      },
      required: ["style", "colors"],
    },
    blush: {
      type: "object",
      properties: {
        colorName: { type: "string" },
        hexCode: { type: "string" },
        placement: { type: "string" },
      },
      required: ["colorName", "hexCode", "placement"],
    },
    eyeliner: {
      type: "object",
      properties: {
        style: { type: "string" },
        colorName: { type: "string" },
      },
      required: ["style", "colorName"],
    },
  },
  required: ["makeupStyleName", "skinUndertone", "lip", "eyeshadow", "blush", "eyeliner"],
};

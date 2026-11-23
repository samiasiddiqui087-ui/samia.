import 'dotenv/config';
import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { FunctionCallingConfigMode, FunctionDeclaration, GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { CartItem, OutfitSchedule, Product, WardrobeItem, WeatherInfo } from './src/types/immerso.ts';
import {
  AuthenticatedAdminRequest,
  getAdminAuditLogs,
  handleAdminChangePassword,
  handleAdminLogin,
  handleAdminLogout,
  handleAdminSessionStatus,
  recordAdminAudit,
  requireAdminAuth,
} from './server/adminAuth.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));

const PORT = Number(process.env.PORT) || 3000;

// Shared server-side Gemini client (API key stays strictly on server)
function getAiClient(apiVersion?: string): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in the server environment.');
  }
  return new GoogleGenAI({
    apiKey,
    ...(apiVersion ? { apiVersion } : {}),
    httpOptions: {
      timeout: apiVersion ? 22_000 : 15_000,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getErrorStatus(error: unknown): number {
  const errObj = error as { status?: number; message?: string };
  if (typeof errObj?.status === 'number' && errObj.status >= 400 && errObj.status < 600) {
    return errObj.status;
  }
  const msg = String(errObj?.message || '');
  if (msg.includes('429') || /quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(msg)) return 429;
  if (msg.includes('503') || /UNAVAILABLE|high demand/i.test(msg)) return 503;
  if (msg.includes('504') || /DEADLINE_EXCEEDED|timed?\s*out/i.test(msg)) return 504;
  return 500;
}

const PRIMARY_TEXT_MODEL = 'gemini-4-hydrogen';
const FALLBACK_TEXT_MODEL = 'gemini-3.1-flash-lite';
let primaryCooldownUntil = 0;

function isRetryableQuotaOrTransient(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 429 || status === 503 || status === 504;
}

async function generateWithFallback(
  ai: GoogleGenAI,
  request: {
    contents: Parameters<GoogleGenAI['models']['generateContent']>[0]['contents'];
    config?: Record<string, unknown>;
  },
  preferredModel?: string
) {
  const now = Date.now();
  const baseOrder =
    now < primaryCooldownUntil
      ? [FALLBACK_TEXT_MODEL]
      : [PRIMARY_TEXT_MODEL, FALLBACK_TEXT_MODEL];
  const modelsToTry = preferredModel
    ? Array.from(new Set([preferredModel, FALLBACK_TEXT_MODEL, PRIMARY_TEXT_MODEL]))
    : baseOrder;
  let lastError: unknown;

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    const hasNextFallback = i < modelsToTry.length - 1;
    const attemptAbort = hasNextFallback ? new AbortController() : null;
    const attemptTimer = attemptAbort ? setTimeout(() => attemptAbort.abort(), 9_000) : null;

    try {
      const cfg = { ...(request.config || {}) };
      if (model === FALLBACK_TEXT_MODEL && 'thinkingConfig' in cfg) {
        delete cfg.thinkingConfig;
      }
      if (attemptAbort && !('abortSignal' in cfg)) {
        cfg.abortSignal = attemptAbort.signal;
      }
      const response = await ai.models.generateContent({
        model,
        contents: request.contents,
        config: cfg,
      });
      return { response, usedModel: model };
    } catch (err) {
      lastError = err;
      const errStatus = getErrorStatus(err);
      const isAborted = err instanceof Error && /abort/i.test(err.name + ' ' + err.message);
      if (model === PRIMARY_TEXT_MODEL) {
        if (errStatus === 429) {
          primaryCooldownUntil = Date.now() + 5 * 60_000;
        } else if (errStatus === 503 || errStatus === 504 || isAborted) {
          primaryCooldownUntil = Date.now() + 2 * 60_000;
        }
      }
      if (!isRetryableQuotaOrTransient(err) && !isAborted) {
        throw err;
      }
      if (hasNextFallback) {
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      if (attemptTimer) clearTimeout(attemptTimer);
    }
  }
  throw lastError;
}

// Simple in-memory rate limiting per IP for AI endpoints
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string, maxRequests = 40, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count += 1;
  return true;
}

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'IMMERSO Backend', timestamp: new Date().toISOString() });
});

// SEO: robots.txt & sitemap.xml
app.get('/robots.txt', (_req: Request, res: Response) => {
  const baseUrl = process.env.APP_URL || 'https://immerso.fashion';
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', (_req: Request, res: Response) => {
  const baseUrl = process.env.APP_URL || 'https://immerso.fashion';
  const routes = ['', '/?page=shop', '/?page=collections', '/?page=ai-stylist', '/?page=wardrobe', '/?page=planner', '/?page=outfit-generator', '/?page=inspiration', '/?page=order-tracking', '/?page=about', '/?page=contact'];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${routes
    .map((r) => `  <url><loc>${baseUrl}${r}</loc><changefreq>daily</changefreq></url>`)
    .join('\n')}\n</urlset>`;
  res.type('application/xml').send(xml);
});

// Real Weather API via Open-Meteo (no fabricated weather)
function mapWeatherCode(code: number): { condition: string; isRainy: boolean } {
  if (code === 0) return { condition: 'Clear Sky', isRainy: false };
  if (code <= 3) return { condition: 'Partly Cloudy', isRainy: false };
  if (code <= 48) return { condition: 'Misty / Foggy', isRainy: false };
  if (code <= 67 || (code >= 80 && code <= 82)) return { condition: 'Rain Showers', isRainy: true };
  if (code <= 77) return { condition: 'Snow / Cold Crisp', isRainy: false };
  if (code >= 95) return { condition: 'Thunderstorm', isRainy: true };
  return { condition: 'Mild Breeze', isRainy: false };
}

function getWeatherStylingTip(tempC: number, isRainy: boolean): string {
  if (isRainy) {
    return 'Opt for water-resistant trench outerwear, darker silk tones, and closed-toe leather or suede footwear.';
  }
  if (tempC >= 28) {
    return 'Breathable Belgian linen tailoring, fluid silk midis, and light ivory palettes keep your silhouette crisp.';
  }
  if (tempC >= 18) {
    return 'Ideal transitional weather for structured blazers layered over fine silk or knitwear separates.';
  }
  return 'Rich wool-cashmere coats, tonal knitwear layering, and structured leather accessories add warmth with polish.';
}

app.get('/api/weather', async (req: Request, res: Response) => {
  try {
    const cityParam = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const latParam = req.query.lat ? Number(req.query.lat) : NaN;
    const lonParam = req.query.lon ? Number(req.query.lon) : NaN;

    let lat = 24.8607;
    let lon = 67.0011;
    let resolvedCity = 'Karachi';

    if (!Number.isNaN(latParam) && !Number.isNaN(lonParam)) {
      lat = latParam;
      lon = lonParam;
      resolvedCity = cityParam || 'Current Location';
    } else {
      const targetCity = cityParam || 'Karachi';
      const geoResp = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(targetCity)}&count=1&language=en&format=json`
      );
      if (geoResp.ok) {
        const geoJson = (await geoResp.json()) as {
          results?: Array<{ latitude: number; longitude: number; name: string; country?: string }>;
        };
        if (geoJson.results && geoJson.results.length > 0) {
          lat = geoJson.results[0].latitude;
          lon = geoJson.results[0].longitude;
          resolvedCity = geoJson.results[0].name;
        }
      }
    }

    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=4`;
    const weatherResp = await fetch(forecastUrl);
    if (!weatherResp.ok) {
      return res.status(502).json({ error: 'Weather service temporarily unavailable.' });
    }

    const wData = (await weatherResp.json()) as {
      current?: {
        temperature_2m: number;
        relative_humidity_2m: number;
        weather_code: number;
        wind_speed_10m: number;
      };
      daily?: {
        time: string[];
        weather_code: number[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
      };
    };

    const currentTemp = Math.round(wData.current?.temperature_2m ?? 24);
    const currentMapped = mapWeatherCode(wData.current?.weather_code ?? 0);

    const payload: WeatherInfo = {
      city: resolvedCity,
      temperatureC: currentTemp,
      condition: currentMapped.condition,
      isRainy: currentMapped.isRainy,
      humidity: wData.current?.relative_humidity_2m,
      windKmh: wData.current?.wind_speed_10m,
      stylingTip: getWeatherStylingTip(currentTemp, currentMapped.isRainy),
      dailyForecast: (wData.daily?.time || []).map((date, idx) => ({
        date,
        maxC: Math.round(wData.daily?.temperature_2m_max[idx] ?? currentTemp),
        minC: Math.round(wData.daily?.temperature_2m_min[idx] ?? currentTemp - 5),
        condition: mapWeatherCode(wData.daily?.weather_code[idx] ?? 0).condition,
      })),
    };

    res.json(payload);
  } catch (error) {
    console.error('Weather API error:', error);
    res.status(500).json({ error: 'Unable to retrieve live weather data.' });
  }
});

// AI Personal Stylist Endpoint (Gemini 4 Hydrogen + Multimodal Image Support)
app.post('/api/ai/stylist', async (req: Request, res: Response) => {
  const ip = req.ip || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many styling requests. Please wait a moment.' });
  }

  try {
    const {
      message,
      history = [],
      catalog = [],
      wardrobe = [],
      weather = null,
      imageBase64,
      imageMimeType,
      preferences,
    } = req.body as {
      message: string;
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      catalog?: Product[];
      wardrobe?: WardrobeItem[];
      weather?: WeatherInfo | null;
      imageBase64?: string;
      imageMimeType?: string;
      preferences?: { preferredStyle?: string; preferredColors?: string[]; preferredSize?: string };
    };

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Prompt message is required.' });
    }

    const ai = getAiClient();

    const catalogSummary = catalog.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      brand: p.brand,
      pricePkr: p.pricePkr,
      colors: p.colors,
      sizes: p.sizes,
      stock: p.stock,
      occasion: p.occasion,
      season: p.season,
    }));

    const wardrobeSummary = wardrobe.map((w) => ({
      name: w.name,
      category: w.category,
      color: w.color,
      season: w.season,
      size: w.size,
      brand: w.brand,
    }));

    const systemInstruction = `You are the IMMERSO Personal AI Fashion Stylist — refined, knowledgeable, warm, and luxury-editorial in tone.
Always ground product recommendations ONLY in the real IMMERSO catalog provided below. NEVER invent products, prices, discounts, or stock counts.
If the user owns items in their Virtual Wardrobe, weave those pieces harmoniously with IMMERSO pieces.
Respect PKR budgets strictly. Mention specific PKR prices, colors, sizes, and styling reasoning.
If an image of clothing is uploaded, analyze its silhouette, color, fabric feel, and suggest matching colors, occasions, and complementary IMMERSO pieces.
Keep responses well-structured, concise, and practical (under 220 words unless a full wardrobe audit is asked).

LIVE CONTEXT:
- Weather: ${weather ? `${weather.city}, ${weather.temperatureC}°C, ${weather.condition}. Tip: ${weather.stylingTip}` : 'Not provided'}
- User Preferences: ${preferences ? JSON.stringify(preferences) : 'Not set'}
- User Virtual Wardrobe (${wardrobeSummary.length} items): ${JSON.stringify(wardrobeSummary.slice(0, 25))}
- Real IMMERSO Product Catalog (${catalogSummary.length} items): ${JSON.stringify(catalogSummary)}

Also return JSON in the exact schema requested so the UI can display matching product cards alongside your reply.`;

    const recentTurns = history
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'Client' : 'IMMERSO Stylist'}: ${m.text}`)
      .join('\n');

    const promptText = recentTurns
      ? `Previous conversation:\n${recentTurns}\n\nClient: ${message}`
      : message;

    const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [];
    if (imageBase64 && imageMimeType) {
      const cleaned = imageBase64.replace(/^data:[^;]+;base64,/, '');
      parts.push({
        inlineData: {
          data: cleaned,
          mimeType: imageMimeType,
        },
      });
    }
    parts.push({ text: promptText });

    const { response } = await generateWithFallback(ai, {
      contents: { parts },
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            reply: {
              type: Type.STRING,
              description: 'Editorial styling response to the client.',
            },
            recommendedProductIds: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'IDs of real IMMERSO catalog products recommended in the reply.',
            },
            colorPalette: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Suggested matching color names.',
            },
          },
          required: ['reply', 'recommendedProductIds'],
        },
      },
    });

    const rawText = (response.text ?? '{}')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    let parsed: {
      reply?: string;
      recommendedProductIds?: string[];
      colorPalette?: string[];
    } = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { reply: rawText || "Here is my tailored styling recommendation from IMMERSO's collection." };
    }

    const validIds = new Set(catalog.map((p) => p.id));
    const matchedProducts = (parsed.recommendedProductIds || [])
      .filter((id) => validIds.has(id))
      .map((id) => catalog.find((p) => p.id === id)!)
      .slice(0, 4);

    res.json({
      reply: parsed.reply || "Here is my tailored styling recommendation from IMMERSO's collection.",
      products: matchedProducts,
      colorPalette: parsed.colorPalette || [],
    });
  } catch (error) {
    console.error('AI Stylist error:', error);
    const errMsg = error instanceof Error ? error.message : 'AI Stylist request failed.';
    res.status(getErrorStatus(error)).json({ error: errMsg });
  }
});

// IMMERSO 3D AI Concierge & Shopping Assistant (Gemini 4 Hydrogen + Catalog, Wardrobe, Planner & Cart Tools)
app.post('/api/ai/chat', async (req: Request, res: Response) => {
  const ip = req.ip || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many assistant requests. Please pause briefly.' });
  }

  try {
    const {
      message,
      history = [],
      catalog = [],
      cart = [],
      wardrobe = [],
      schedules = [],
      weather = null,
      preferences,
      language = 'en',
    } = req.body as {
      message: string;
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      catalog?: Product[];
      cart?: CartItem[];
      wardrobe?: WardrobeItem[];
      schedules?: OutfitSchedule[];
      weather?: WeatherInfo | null;
      preferences?: { preferredStyle?: string; preferredColors?: string[]; preferredSize?: string };
      language?: 'en' | 'ur';
    };

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const ai = getAiClient();

    const searchProductsDecl: FunctionDeclaration = {
      name: 'searchProducts',
      description:
        'Search the real IMMERSO product catalog by keyword, category, color, size, occasion, or maximum price in PKR. Also use to find matching accessories, handbags, jewellery, or shoes.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING, description: 'Search keyword like dress, handbag, blazer, kaftan, heels, pearl' },
          category: { type: Type.STRING, description: 'Optional category name' },
          color: { type: Type.STRING, description: 'Optional color filter like Black, Beige, Ivory, Taupe, Gold, Brown' },
          size: { type: Type.STRING, description: 'Optional size filter like XS, S, M, L, XL, 38' },
          maxPricePkr: { type: Type.NUMBER, description: 'Optional maximum budget in PKR' },
          occasion: { type: Type.STRING, description: 'Optional occasion like Party, Formal, Office, Wedding, Casual' },
        },
      },
    };

    const addToCartDecl: FunctionDeclaration = {
      name: 'addToCart',
      description: 'Add a real product from the IMMERSO catalog to the customer shopping cart.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          productId: { type: Type.STRING, description: 'Exact ID of the product from catalog' },
          size: { type: Type.STRING, description: 'Selected size available on the product' },
          color: { type: Type.STRING, description: 'Selected color available on the product' },
          quantity: { type: Type.INTEGER, description: 'Quantity to add (minimum 1)' },
        },
        required: ['productId', 'quantity'],
      },
    };

    const updateCartDecl: FunctionDeclaration = {
      name: 'updateCartItem',
      description: 'Update quantity or remove a product currently in the customer cart.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          productId: { type: Type.STRING, description: 'Product ID in cart' },
          quantity: { type: Type.INTEGER, description: 'New quantity (0 removes the item)' },
        },
        required: ['productId', 'quantity'],
      },
    };

    const openCheckoutDecl: FunctionDeclaration = {
      name: 'openCheckout',
      description: 'Open the WhatsApp checkout modal or shopping bag drawer when the customer wants to view cart or checkout.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          target: { type: Type.STRING, description: '"cart" or "checkout"' },
        },
        required: ['target'],
      },
    };

    const navigateToPageDecl: FunctionDeclaration = {
      name: 'navigateToPage',
      description:
        'Navigate to a specific IMMERSO experience page when the user asks to open their wardrobe, outfit planner, shop, AI stylist studio, outfit generator, virtual try-on, or order tracking.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          page: {
            type: Type.STRING,
            description:
              'One of: "wardrobe", "planner", "shop", "collections", "ai-stylist", "outfit-generator", "virtual-tryon", "inspiration", "order-tracking"',
          },
        },
        required: ['page'],
      },
    };

    const saveOutfitPlanDecl: FunctionDeclaration = {
      name: 'saveOutfitPlan',
      description:
        'Schedule a curated outfit onto the customer outfit planner calendar for a specific YYYY-MM-DD date.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          date: { type: Type.STRING, description: 'ISO date YYYY-MM-DD' },
          title: { type: Type.STRING, description: 'Short outfit title' },
          occasion: { type: Type.STRING, description: 'Occasion like Office, Wedding, Dinner, Casual' },
          productIds: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Real catalog product IDs' },
          accessoriesNote: { type: Type.STRING, description: 'Styling note for bag/jewellery/shoes' },
        },
        required: ['date', 'title', 'occasion', 'productIds'],
      },
    };

    const catalogSnapshot = catalog.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      pricePkr: p.pricePkr,
      colors: p.colors,
      sizes: p.sizes,
      stock: p.stock,
      occasion: p.occasion,
      season: p.season,
      isNewArrival: p.isNewArrival,
      isBestSeller: p.isBestSeller,
    }));

    const wardrobeSummary = wardrobe.slice(0, 25).map((w) => ({
      name: w.name,
      category: w.category,
      color: w.color,
      season: w.season,
      size: w.size,
      brand: w.brand,
    }));

    const scheduleSummary = schedules.slice(0, 12).map((s) => ({
      date: s.date,
      title: s.title,
      occasion: s.occasion,
    }));

    const todayIso = new Date().toISOString().slice(0, 10);

    const systemInstruction = `You are AURORA, the luxury 3D AI fashion concierge and shopping assistant for IMMERSO.
You communicate naturally via both voice and text in a warm, intelligent, editorial luxury voice.
CAPABILITIES & STRICT RULES:
1. NEVER invent products, prices, discounts, or stock counts. Use ONLY the real catalog below and searchProducts.
2. When a customer asks to find/show outfits, dresses, handbags, accessories, jewellery, shoes, blazers, or price comparisons, ALWAYS call searchProducts so interactive product cards appear alongside your spoken response.
3. For accessory/handbag pairing questions (e.g., "which bag goes with the Noir dress?"), search real handbags/jewellery/heels in the catalog and explain the pairing clearly.
4. For wardrobe organization or outfit planning questions, reference the customer's actual Virtual Wardrobe items (${wardrobeSummary.length}), upcoming scheduled outfits (${scheduleSummary.length}), and live weather, and use saveOutfitPlan or navigateToPage when they ask to plan or open Wardrobe/Planner. Today's date is ${todayIso}.
5. When a customer asks to add an item to cart or buy it, check size/color/quantity and call addToCart or openCheckout.
6. Remember conversation context across turns cleanly — refer back to what they previously asked for (their budget, preferred color, occasion, or previously viewed piece) without repeating generic greetings.
7. Language rule: ${language === 'ur' ? 'Respond fluently in natural conversational Urdu (or polished Urdu script / Roman Urdu depending on how the user spoke) while keeping exact product names and Rs. prices clear.' : 'Respond in crisp, warm, human-sounding English.'}
8. Keep spoken responses natural and concise (2 to 4 clear sentences without heavy markdown symbols like ** or ###, since your reply is read aloud as voice and displayed as live subtitles).

LIVE CONTEXT:
- Weather: ${weather ? `${weather.city}, ${weather.temperatureC}°C, ${weather.condition}` : 'Not provided'}
- User Preferences: ${preferences ? JSON.stringify(preferences) : 'Not set'}
- Current Cart (${cart.length} items): ${JSON.stringify(cart)}
- Virtual Wardrobe (${wardrobeSummary.length} items): ${JSON.stringify(wardrobeSummary)}
- Upcoming Schedules: ${JSON.stringify(scheduleSummary)}
- Real IMMERSO Catalog (${catalogSnapshot.length} items): ${JSON.stringify(catalogSnapshot)}`;

    const historyText = history
      .slice(-10)
      .map((m) => `${m.role === 'user' ? 'Client' : 'AURORA'}: ${m.text}`)
      .join('\n');

    const userContent = historyText ? `${historyText}\nClient: ${message}` : message;

    const tools = [
      {
        functionDeclarations: [
          searchProductsDecl,
          addToCartDecl,
          updateCartDecl,
          openCheckoutDecl,
          navigateToPageDecl,
          saveOutfitPlanDecl,
        ],
      },
    ];

    const { response: turn1, usedModel } = await generateWithFallback(ai, {
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      config: {
        systemInstruction,
        tools,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });

    const functionCalls = turn1.functionCalls;
    let matchedProducts: Product[] = [];
    const cartActions: Array<{
      type: 'add' | 'update' | 'remove' | 'open_cart' | 'open_checkout' | 'navigate' | 'schedule_outfit';
      productId?: string;
      size?: string;
      color?: string;
      quantity?: number;
      page?: string;
      schedule?: {
        date: string;
        title: string;
        occasion: string;
        productIds: string[];
        accessoriesNote?: string;
      };
    }> = [];

    const stemToken = (word: string) =>
      word.toLowerCase().replace(/ies$/, 'y').replace(/(ss)$/, '$1').replace(/(es|s)$/, '');

    if (functionCalls && functionCalls.length > 0) {
      const toolResponseParts = [];
      for (const call of functionCalls) {
        const args = (call.args || {}) as Record<string, unknown>;
        if (call.name === 'searchProducts') {
          const q = String(args.query || '').toLowerCase().trim();
          const cat = String(args.category || '').toLowerCase().trim();
          const col = String(args.color || '').toLowerCase().trim();
          const sz = String(args.size || '').toLowerCase().trim();
          const occ = String(args.occasion || '').toLowerCase().trim();
          const maxP = typeof args.maxPricePkr === 'number' ? args.maxPricePkr : Infinity;

          const stopWords = new Set(['for', 'the', 'and', 'with', 'under', 'below', 'pkr', 'rs', 'show', 'find', 'me', 'some', 'any', 'matching']);

          const expandSynonymTokens = (raw: string): string[] => {
            const base = raw
              .split(/\s+/)
              .map((t) => t.replace(/[^a-z0-9]/gi, ''))
              .filter((t) => t.length > 1 && !stopWords.has(t));
            const expanded = new Set<string>(base);
            for (const tok of base) {
              const s = stemToken(tok);
              expanded.add(s);
              if (/accessor/i.test(tok)) {
                ['handbag', 'jewellery', 'pearl', 'earring', 'shoes', 'slingback', 'bag'].forEach((w) => expanded.add(w));
              }
              if (/bag|purse|tote|clutch/i.test(tok)) {
                ['handbag', 'calfskin'].forEach((w) => expanded.add(w));
              }
              if (/shoe|heel|footwear|pump|sandal/i.test(tok)) {
                ['shoes', 'slingback', 'suede'].forEach((w) => expanded.add(w));
              }
              if (/jewel|earring|necklace|ring/i.test(tok)) {
                ['jewellery', 'pearl', 'gold'].forEach((w) => expanded.add(w));
              }
            }
            return Array.from(expanded);
          };

          const found = catalog.filter((p) => {
            if (p.pricePkr > maxP) return false;
            const hay = `${p.name} ${p.description} ${p.category} ${p.brand} ${p.occasion || ''} ${p.colors.join(' ')} ${p.season || ''}`.toLowerCase();

            if (col) {
              const colStem = stemToken(col);
              const hasColor = p.colors.some((c) => c.toLowerCase().includes(col) || c.toLowerCase().includes(colStem)) || hay.includes(colStem);
              if (!hasColor) return false;
            }
            if (sz && !p.sizes.some((s) => s.toLowerCase() === sz)) return false;
            if (cat) {
              const catTokens = expandSynonymTokens(cat);
              const catMatch = catTokens.some((t) => hay.includes(t));
              if (!catMatch) return false;
            }
            if (occ && !hay.includes(stemToken(occ))) {
              return false;
            }
            if (q) {
              const tokens = expandSynonymTokens(q);
              if (tokens.length > 0) {
                const anyMatch = tokens.some((tok) => hay.includes(tok));
                if (!anyMatch) return false;
              }
            }
            return true;
          });

          const batch = found.slice(0, 6);
          const seenIds = new Set(matchedProducts.map((m) => m.id));
          for (const item of batch) {
            if (!seenIds.has(item.id) && matchedProducts.length < 6) {
              matchedProducts.push(item);
              seenIds.add(item.id);
            }
          }
          toolResponseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: {
                count: matchedProducts.length,
                products: matchedProducts.map((p) => ({
                  id: p.id,
                  name: p.name,
                  category: p.category,
                  pricePkr: p.pricePkr,
                  colors: p.colors,
                  sizes: p.sizes,
                  stock: p.stock,
                })),
              },
            },
          });
        } else if (call.name === 'addToCart') {
          const productId = String(args.productId || '');
          const product = catalog.find((p) => p.id === productId);
          if (product && product.stock > 0) {
            const size = String(args.size || product.sizes[0] || 'One Size');
            const color = String(args.color || product.colors[0] || 'Default');
            const quantity = Math.max(1, Math.min(product.stock, Number(args.quantity || 1)));
            cartActions.push({ type: 'add', productId, size, color, quantity });
            matchedProducts = [product];
            toolResponseParts.push({
              functionResponse: {
                id: call.id,
                name: call.name,
                response: { success: true, added: { name: product.name, size, color, quantity, pricePkr: product.pricePkr } },
              },
            });
          } else {
            toolResponseParts.push({
              functionResponse: {
                id: call.id,
                name: call.name,
                response: { success: false, error: 'Product not found or out of stock.' },
              },
            });
          }
        } else if (call.name === 'updateCartItem') {
          const productId = String(args.productId || '');
          const quantity = Number(args.quantity ?? 0);
          cartActions.push(
            quantity <= 0 ? { type: 'remove', productId } : { type: 'update', productId, quantity }
          );
          toolResponseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: { success: true, productId, quantity },
            },
          });
        } else if (call.name === 'openCheckout') {
          const target = String(args.target || 'checkout');
          cartActions.push({ type: target === 'cart' ? 'open_cart' : 'open_checkout' });
          toolResponseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: { opened: target },
            },
          });
        } else if (call.name === 'navigateToPage') {
          const page = String(args.page || 'shop');
          cartActions.push({ type: 'navigate', page });
          toolResponseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: { navigatedTo: page },
            },
          });
        } else if (call.name === 'saveOutfitPlan') {
          const validIds = new Set(catalog.map((p) => p.id));
          const requestedIds = Array.isArray(args.productIds)
            ? args.productIds.map((id) => String(id)).filter((id) => validIds.has(id))
            : [];
          const schedule = {
            date: String(args.date || todayIso),
            title: String(args.title || 'Curated IMMERSO Look'),
            occasion: String(args.occasion || 'Formal'),
            productIds: requestedIds,
            accessoriesNote: args.accessoriesNote ? String(args.accessoriesNote) : undefined,
          };
          cartActions.push({ type: 'schedule_outfit', schedule });
          matchedProducts = requestedIds
            .map((id) => catalog.find((p) => p.id === id))
            .filter((p): p is Product => Boolean(p));
          toolResponseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: { scheduled: schedule },
            },
          });
        }
      }

      const previousContent = turn1.candidates?.[0]?.content;
      if (previousContent) {
        const { response: turn2 } = await generateWithFallback(
          ai,
          {
            contents: [
              { role: 'user', parts: [{ text: userContent }] },
              previousContent,
              { role: 'user', parts: toolResponseParts },
            ],
            config: {
              systemInstruction,
              tools,
              toolConfig: {
                functionCallingConfig: {
                  mode: FunctionCallingConfigMode.NONE,
                },
              },
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            },
          },
          usedModel
        );
        const fallbackText =
          matchedProducts.length > 0
            ? `I curated ${matchedProducts.length} piece${matchedProducts.length > 1 ? 's' : ''} from our collection: ${matchedProducts.map((p) => `${p.name} at Rs. ${p.pricePkr.toLocaleString()}`).join(', ')}. You can select your size and color below.`
            : 'I checked our current collection, and no pieces matched those exact criteria. Tell me your preferred color, occasion, or budget and I will refine the search.';
        return res.json({
          reply: (turn2.text || '').trim() || fallbackText,
          products: matchedProducts,
          cartActions,
        });
      }
    }

    res.json({
      reply: turn1.text || 'How may I curate your wardrobe or assist your shopping today?',
      products: matchedProducts,
      cartActions,
    });
  } catch (error) {
    console.error('AI Chat error:', error);
    const errMsg = error instanceof Error ? error.message : 'Assistant error.';
    res.status(getErrorStatus(error)).json({ error: errMsg });
  }
});

// Server-side cache & cooldown for Trending Now (prevents redundant quota burn & deadline timeouts)
const TRENDING_CACHE_TTL_MS = 15 * 60_000;
const trendingCache = new Map<string, { expiresAt: number; payload: unknown }>();
const trendingInFlight = new Map<string, Promise<unknown>>();
let searchGroundingCooldownUntil = 0;

// Trending Now AI Fashion Trend Analyzer (Gemini + Google Search Grounding -> Matched Boutique Items)
app.post('/api/ai/trending', async (req: Request, res: Response) => {
  const ip = req.ip || 'unknown';
  if (!checkRateLimit(ip, 20, 60_000)) {
    return res.status(429).json({ error: 'Too many trend analysis requests. Please wait a moment.' });
  }

  try {
    const {
      focus = 'All Luxury Trends',
      catalog = [],
      weather = null,
      forceRefresh = false,
    } = req.body as {
      focus?: string;
      catalog?: Product[];
      weather?: WeatherInfo | null;
      forceRefresh?: boolean;
    };

    if (!Array.isArray(catalog) || catalog.length === 0) {
      return res.status(400).json({ error: 'Boutique catalog is required to match fashion trends.' });
    }

    const inStockCatalog = catalog.filter((p) => p.stock > 0);
    const activeCatalog = inStockCatalog.length > 0 ? inStockCatalog : catalog;
    const cacheKey = `${focus}|${activeCatalog.map((p) => p.id).join(',')}|${weather?.condition || 'all'}`;

    if (!forceRefresh) {
      const cached = trendingCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return res.json(cached.payload);
      }
    }

    const existingJob = trendingInFlight.get(cacheKey);
    if (existingJob) {
      const sharedPayload = await existingJob;
      return res.json(sharedPayload);
    }

    const jobPromise = (async () => {
      const ai = getAiClient();
      const currentDate = new Date().toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
      });

      // Step 1: Attempt real-time fashion trend research via Google Search Grounding
      // Uses cooldown when Search Grounding quota is temporarily exhausted to avoid 429/504 cascades
      let trendReport = '';
      let sources: Array<{ title: string; uri: string }> = [];

      if (Date.now() >= searchGroundingCooldownUntil) {
        const searchAbort = new AbortController();
        const searchTimer = setTimeout(() => searchAbort.abort(), 4500);
        try {
          const searchModel = Date.now() < primaryCooldownUntil ? FALLBACK_TEXT_MODEL : PRIMARY_TEXT_MODEL;
          const searchResp = await ai.models.generateContent({
            model: searchModel,
            contents: `Summarize the top 3 luxury & contemporary fashion trends in ${currentDate} for "${focus}" in 4 concise bullet points (silhouettes, palettes, textiles, handbags/footwear).`,
            config: {
              tools: [{ googleSearch: {} }],
              abortSignal: searchAbort.signal,
            },
          });
          trendReport = (searchResp.text || '').trim();
          const rawChunks = (searchResp.candidates?.[0]?.groundingMetadata?.groundingChunks || []) as Array<{
            web?: { uri?: string; title?: string };
          }>;
          sources = rawChunks
            .map((c) => ({
              title: c.web?.title || 'Fashion Editorial Source',
              uri: c.web?.uri || '',
            }))
            .filter((s) => Boolean(s.uri))
            .slice(0, 5);
        } catch (searchErr) {
          const searchStatus = getErrorStatus(searchErr);
          const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
          if (
            searchStatus === 429 ||
            searchStatus === 503 ||
            searchStatus === 504 ||
            /abort|timed out|504|503|DEADLINE_EXCEEDED/i.test(msg)
          ) {
            searchGroundingCooldownUntil = Date.now() + 15 * 60_000;
          }
          console.info(`Trending Now grounding skipped (status ${searchStatus}); continuing with direct Gemini trend synthesis.`);
        } finally {
          clearTimeout(searchTimer);
        }
      }

      const catalogSummary = activeCatalog.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        pricePkr: p.pricePkr,
        colors: p.colors,
        occasion: p.occasion,
        season: p.season,
      }));

      // Step 2: Structured synthesis matching current fashion trends to our real boutique catalog
      const { response: structuredResp } = await generateWithFallback(
        ai,
        {
          contents: `Analyze 3 distinct, authoritative luxury fashion trends for ${currentDate} (Focus: ${focus}).
${trendReport ? `Live trend briefing:\n---\n${trendReport}\n---\n` : ''}
Weather context: ${weather ? `${weather.city}, ${weather.temperatureC}°C (${weather.condition})` : 'All season'}
IMMERSO Boutique Catalog (${catalogSummary.length} in-stock items):
${JSON.stringify(catalogSummary)}

Return a structured editorial Trending Now analysis with 3 distinct trends (silhouettes, palettes, textiles, quiet luxury / modern festive direction). For each trend, recommend 1 to 3 REAL product IDs from the IMMERSO Boutique Catalog above.`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                seasonHeadline: { type: Type.STRING },
                trends: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      trendTitle: { type: Type.STRING },
                      trendSummary: { type: Type.STRING },
                      palette: { type: Type.ARRAY, items: { type: Type.STRING } },
                      stylingCue: { type: Type.STRING },
                      matchedProductIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                    },
                    required: ['trendTitle', 'trendSummary', 'palette', 'stylingCue', 'matchedProductIds'],
                  },
                },
              },
              required: ['seasonHeadline', 'trends'],
            },
          },
        },
        FALLBACK_TEXT_MODEL
      );

      const rawJson = (structuredResp.text ?? '{}')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
      const parsed = JSON.parse(rawJson) as {
        seasonHeadline?: string;
        trends?: Array<{
          trendTitle: string;
          trendSummary: string;
          palette: string[];
          stylingCue: string;
          matchedProductIds: string[];
        }>;
      };

      const catalogMap = new Map(catalog.map((p) => [p.id, p]));
      const trends = (parsed.trends || []).map((t) => ({
        trendTitle: t.trendTitle,
        trendSummary: t.trendSummary,
        palette: t.palette || [],
        stylingCue: t.stylingCue,
        matchedProducts: (t.matchedProductIds || [])
          .map((id) => catalogMap.get(id))
          .filter((p): p is Product => Boolean(p))
          .slice(0, 3),
      }));

      const payload = {
        seasonHeadline: parsed.seasonHeadline || `Current Luxury Edit · ${currentDate}`,
        analyzedAt: new Date().toISOString(),
        trends,
        sources,
      };

      trendingCache.set(cacheKey, {
        expiresAt: Date.now() + TRENDING_CACHE_TTL_MS,
        payload,
      });

      return payload;
    })();

    trendingInFlight.set(cacheKey, jobPromise);
    try {
      const payload = await jobPromise;
      return res.json(payload);
    } finally {
      trendingInFlight.delete(cacheKey);
    }
  } catch (error) {
    const status = getErrorStatus(error);
    console.error(`Trending Now AI error (HTTP ${status}):`, error instanceof Error ? error.message : error);
    const friendlyMessage =
      status === 429
        ? 'Trend intelligence reached temporary API quota limits. Please wait a moment and click Retry.'
        : status === 504 || status === 503
          ? 'The trend analysis service took longer than expected. Please click Retry.'
          : 'Unable to analyze live fashion trends right now. Please try again.';
    return res.status(status).json({ error: friendlyMessage });
  }
});

// Natural Human-Like AI Voice Synthesis (Gemini 3.8 Flash Lite TTS via Interactions API)
app.post('/api/ai/tts', async (req: Request, res: Response) => {
  const ip = req.ip || 'unknown';
  if (!checkRateLimit(ip, 35, 60_000)) {
    return res.status(429).json({ error: 'Voice synthesis rate limit reached.' });
  }

  try {
    const { text, language = 'en' } = req.body as { text: string; language?: 'en' | 'ur' };
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text is required for speech synthesis.' });
    }

    // Strip markdown formatting for clean natural spoken prosody
    const cleanSpeechText = text
      .replace(/[*_`#>]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 900);

    if (!cleanSpeechText) {
      return res.status(400).json({ error: 'No speakable content provided.' });
    }

    const ai = getAiClient('v1beta');
    const interaction = await ai.interactions.create({
      model: 'gemini-3.8-flash-lite-tts',
      input: [
        {
          type: 'text',
          text: cleanSpeechText,
          annotations: [
            {
              type: 'speech_metadata',
              style:
                language === 'ur'
                  ? 'Warm, poised, articulate luxury boutique fashion stylist speaking clearly in Urdu and English'
                  : 'Warm, poised, intelligent luxury fashion atelier concierge with calm editorial phrasing',
            },
          ],
        },
      ],
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: [
          {
            language: language === 'ur' ? 'ur-PK' : 'en-US',
            voice: 'Kore',
          },
        ],
      },
    });

    const audio = interaction.output_audio;
    if (!audio?.data) {
      return res.status(502).json({ error: 'Audio synthesis returned empty payload.' });
    }

    res.json({ audioBase64: audio.data, mimeType: audio.mime_type || 'audio/wav' });
  } catch (error) {
    console.error('AI TTS error:', error);
    const errMsg = error instanceof Error ? error.message : 'TTS generation failed.';
    res.status(getErrorStatus(error)).json({ error: errMsg });
  }
});

// AI Outfit Generator Endpoint
app.post('/api/ai/outfit-generator', async (req: Request, res: Response) => {
  const ip = req.ip || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit reached. Please wait a moment.' });
  }

  try {
    const {
      categoryPreference,
      occasion,
      weather,
      budgetPkr,
      preferredColors,
      clothingType,
      aesthetic,
      season,
      catalog = [],
    } = req.body as {
      categoryPreference: string;
      occasion: string;
      weather: string;
      budgetPkr: number;
      preferredColors: string;
      clothingType: string;
      aesthetic: string;
      season: string;
      catalog: Product[];
    };

    const ai = getAiClient();
    const catalogData = catalog.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      pricePkr: p.pricePkr,
      colors: p.colors,
      stock: p.stock,
      occasion: p.occasion,
      season: p.season,
    }));

    const { response } = await generateWithFallback(ai, {
      contents: `Generate 2 complete luxury outfit combinations from the IMMERSO catalog matching:
Category/Gender: ${categoryPreference}
Occasion: ${occasion}
Weather: ${weather}
Budget: Rs. ${budgetPkr}
Preferred Colors: ${preferredColors}
Clothing Type: ${clothingType}
Aesthetic: ${aesthetic}
Season: ${season}

Catalog: ${JSON.stringify(catalogData)}

Select ONLY real product IDs from the catalog above where stock > 0. Aim to include primary garment + matching bag/shoes/jewellery when budget allows.`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              productIds: { type: Type.ARRAY, items: { type: Type.STRING } },
              accessoriesNote: { type: Type.STRING },
              footwearNote: { type: Type.STRING },
              colorPalette: { type: Type.ARRAY, items: { type: Type.STRING } },
              stylingExplanation: { type: Type.STRING },
            },
            required: ['title', 'productIds', 'accessoriesNote', 'footwearNote', 'colorPalette', 'stylingExplanation'],
          },
        },
      },
    });

    const rawOutfitJson = (response.text ?? '[]')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const parsed = JSON.parse(rawOutfitJson) as Array<{
      title: string;
      productIds: string[];
      accessoriesNote: string;
      footwearNote: string;
      colorPalette: string[];
      stylingExplanation: string;
    }>;

    const validMap = new Map(catalog.map((p) => [p.id, p]));
    const outfits = parsed.map((o) => {
      const items = (o.productIds || [])
        .map((id) => validMap.get(id))
        .filter((p): p is Product => Boolean(p));
      const totalEstimatedPkr = items.reduce((sum, p) => sum + p.pricePkr, 0);
      return {
        ...o,
        items,
        totalEstimatedPkr,
      };
    });

    res.json({ outfits });
  } catch (error) {
    console.error('Outfit Generator error:', error);
    const errMsg = error instanceof Error ? error.message : 'Failed to generate outfits.';
    res.status(getErrorStatus(error)).json({ error: errMsg });
  }
});

// AI Virtual Try-On Endpoint (Gemini Image Editing)
app.post('/api/ai/virtual-tryon', async (req: Request, res: Response) => {
  const ip = req.ip || 'unknown';
  if (!checkRateLimit(ip, 12, 60_000)) {
    return res.status(429).json({ error: 'Try-on rate limit reached. Please wait a minute.' });
  }

  try {
    const { userPhotoBase64, userPhotoMimeType, product } = req.body as {
      userPhotoBase64: string;
      userPhotoMimeType: string;
      product: Product;
    };

    if (!userPhotoBase64 || !product?.name) {
      return res.status(400).json({ error: 'Both a personal photo and a selected product are required.' });
    }

    const ai = getAiClient();
    const cleaned = userPhotoBase64.replace(/^data:[^;]+;base64,/, '');

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite-image',
      contents: {
        parts: [
          {
            inlineData: {
              data: cleaned,
              mimeType: userPhotoMimeType || 'image/jpeg',
            },
          },
          {
            text: `Create a tasteful, realistic luxury fashion virtual try-on preview where the person in this photo is wearing the "${product.name}" (${product.category} in ${product.colors[0] || 'signature tone'}, ${product.description}). Preserve the person's identity, face, pose, and natural lighting in a warm upscale boutique setting.`,
          },
        ],
      },
    });

    let generatedDataUrl = '';
    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType ?? 'image/png';
        generatedDataUrl = `data:${mime};base64,${part.inlineData.data}`;
        break;
      }
    }

    if (!generatedDataUrl) {
      return res.status(502).json({
        error: 'The image model did not return a preview image. Please try another portrait photo.',
      });
    }

    res.json({
      previewDataUrl: generatedDataUrl,
      disclaimer:
        'Illustrative AI preview only. Actual garment drape, fabric sheen, and fit may vary by body measurements.',
    });
  } catch (error) {
    console.error('Virtual Try-On error:', error);
    const message = error instanceof Error ? error.message : 'Virtual try-on failed.';
    const status = message.includes('403') || message.includes('PERMISSION_DENIED') || message.includes('429')
      ? 402
      : 500;
    res.status(status).json({
      error:
        status === 402
          ? 'Virtual Try-On image generation requires a billing-enabled Gemini API key in Settings > Secrets.'
          : message,
    });
  }
});

// Optional Meta WhatsApp Cloud API Admin Notification (+923112537554)
app.post('/api/whatsapp/notify-order', async (req: Request, res: Response) => {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

  if (!token || !phoneNumberId || !businessAccountId) {
    return res.json({
      sent: false,
      configured: false,
      message: 'Meta WhatsApp Cloud API credentials not configured; customer wa.me flow active.',
    });
  }

  try {
    const { orderId, customerName, customerPhone, totalPkr, itemsSummary } = req.body as {
      orderId: string;
      customerName: string;
      customerPhone: string;
      totalPkr: number;
      itemsSummary: string;
    };

    const appUrl = process.env.APP_URL || '';
    const adminLink = appUrl ? `${appUrl}/?page=admin` : 'IMMERSO Admin Dashboard';

    const metaResp = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: '923112537554',
          type: 'text',
          text: {
            body: `New IMMERSO Order ${orderId}\nCustomer: ${customerName} (${customerPhone})\nItems: ${itemsSummary}\nTotal: Rs. ${totalPkr}\nManage: ${adminLink}`,
          },
        }),
      }
    );

    const data = await metaResp.json();
    if (!metaResp.ok) {
      return res.status(metaResp.status).json({ sent: false, configured: true, error: data });
    }
    res.json({ sent: true, configured: true, data });
  } catch (error) {
    console.error('Meta WhatsApp Cloud API error:', error);
    res.status(500).json({ sent: false, configured: true, error: 'Notification failed.' });
  }
});

// ============================================================
// Secure Admin Authentication & Server-Protected Admin Routes
// ============================================================
app.post('/api/admin/auth/login', handleAdminLogin);

app.get('/api/admin/auth/session', requireAdminAuth(), handleAdminSessionStatus);

app.post('/api/admin/auth/change-password', requireAdminAuth(), handleAdminChangePassword);

app.post('/api/admin/auth/logout', requireAdminAuth(), handleAdminLogout);

// All operational admin routes require a verified server-side admin session
app.get('/api/admin/overview', requireAdminAuth(), (req: AuthenticatedAdminRequest, res: Response) => {
  res.json({
    authorized: true,
    adminEmail: req.adminAuth?.email,
    mustChangePassword: Boolean(req.adminAuth?.mustChangePassword),
    securityMode: 'bcrypt-12 + HMAC-SHA256 HttpOnly Partitioned Session',
    auditLogs: getAdminAuditLogs(),
    serverTimestamp: new Date().toISOString(),
  });
});

app.get('/api/admin/analytics', requireAdminAuth(), (req: AuthenticatedAdminRequest, res: Response) => {
  res.json({ authorized: true, section: 'analytics', adminEmail: req.adminAuth?.email });
});

app.get('/api/admin/products', requireAdminAuth(), (req: AuthenticatedAdminRequest, res: Response) => {
  res.json({ authorized: true, section: 'products', adminEmail: req.adminAuth?.email });
});

app.get('/api/admin/orders', requireAdminAuth(), (req: AuthenticatedAdminRequest, res: Response) => {
  res.json({ authorized: true, section: 'orders', adminEmail: req.adminAuth?.email });
});

app.get('/api/admin/customers', requireAdminAuth(), (req: AuthenticatedAdminRequest, res: Response) => {
  res.json({ authorized: true, section: 'customers', adminEmail: req.adminAuth?.email });
});

app.get('/api/admin/settings', requireAdminAuth(), (req: AuthenticatedAdminRequest, res: Response) => {
  res.json({ authorized: true, section: 'settings', adminEmail: req.adminAuth?.email });
});

app.post('/api/admin/audit', requireAdminAuth(), (req: AuthenticatedAdminRequest, res: Response) => {
  const action = typeof req.body?.action === 'string' ? req.body.action.trim().slice(0, 60) : '';
  const detail = typeof req.body?.detail === 'string' ? req.body.detail.trim().slice(0, 240) : '';
  if (!action) {
    return res.status(400).json({ error: 'Action name is required.' });
  }
  recordAdminAudit(req.adminAuth?.email || 'admin', action, detail);
  res.json({ authorized: true, auditLogs: getAdminAuditLogs() });
});

app.all('/api/admin/*', requireAdminAuth(), (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Admin API endpoint not found.' });
});

// Vite / Static Asset Mounting
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`IMMERSO server running on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
